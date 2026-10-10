# Card and action abstraction: state of the art and gaps in our blueprint

Topic key: `abstraction`. Written 2026-10-09 for the GPO Pluribus-level bot project.

Primary sources were downloaded and read as text. Local copies (PDF plus extracted text) are in
`/Users/rg/Downloads/gpo-research/_src/abstraction/`, together with a clone of Waugh's
hand-isomorphism library and a tiny probe program (`sz.c`) that prints its index sizes.

Every number below carries a source URL. Anything marked "my estimate" is my own arithmetic and
is labeled as such; anything I could not source is marked "unverified".

## 1. Sources read

| Short name | Paper | URL |
| --- | --- | --- |
| Pluribus | Brown & Sandholm, "Superhuman AI for multiplayer poker", Science 2019 | https://noambrown.github.io/papers/19-Science-Superhuman.pdf |
| Pluribus-SM | Supplementary materials for the above | https://noambrown.github.io/papers/19-Science-Superhuman_Supp.pdf |
| Libratus | Brown & Sandholm, "Superhuman AI for heads-up no-limit poker: Libratus beats top professionals", Science 2018 | https://par.nsf.gov/servlets/purl/10077416 |
| GS14 | Ganzfried & Sandholm, "Potential-Aware Imperfect-Recall Abstraction with Earth Mover's Distance in Imperfect-Information Games", AAAI 2014 | https://www.cs.cmu.edu/~sandholm/potential-aware_imperfect-recall.aaai14.pdf |
| J13 | Johanson, Burch, Valenzano, Bowling, "Evaluating State-Space Abstractions in Extensive-Form Games", AAMAS 2013 | https://poker.cs.ualberta.ca/publications/AAMAS13-abstraction.pdf |
| W13 | Waugh, "A Fast and Optimal Hand Isomorphism Algorithm", AAAI-13 Computer Poker workshop | https://www.cs.cmu.edu/~waugh/publications/isomorphism13.pdf |
| W13-code | hand-isomorphism C library | https://github.com/kdub0/hand-isomorphism |
| GS13 | Ganzfried & Sandholm, "Action Translation in Extensive-Form Games with Large Action Spaces: Axioms, Paradoxes, and the Pseudo-Harmonic Mapping", IJCAI 2013 | https://www.cs.cmu.edu/~sandholm/reverse%20mapping.ijcai13.pdf |
| T7 | Brown, Ganzfried, Sandholm, "Hierarchical Abstraction, Distributed Equilibrium Computation, and Post-Processing, with Application to a Champion No-Limit Texas Hold'em Agent", AAMAS 2015 | https://www.cs.cmu.edu/~sandholm/hierarchical.aamas15.pdf |
| BT8 | Brown & Sandholm, "Baby Tartanian8: Winning Agent from the 2016 ACPC", IJCAI 2016 demo | https://www.cs.cmu.edu/~sandholm/BabyTartanian8.ijcai16demo.pdf |
| RT14 | Brown & Sandholm, "Regret Transfer and Parameter Optimization", AAAI 2014 | https://www.cs.cmu.edu/~sandholm/regret_transfer.aaai14.pdf |
| LBR | Lisy & Bowling, "Equilibrium Approximation Quality of Current No-Limit Poker Bots", 2017 | https://arxiv.org/abs/1612.07547 |
| DeepStack | Moravcik et al., "DeepStack: Expert-Level Artificial Intelligence in Heads-Up No-Limit Poker", Science 2017 (arXiv version with supplement) | https://arxiv.org/abs/1701.01724 |
| W09-IR | Waugh et al., "A Practical Use of Imperfect Recall", SARA 2009 | https://poker.cs.ualberta.ca/publications/sara09.pdf |
| W09-path | Waugh, Schnizlein, Bowling, Szafron, "Abstraction Pathologies in Extensive Games", AAMAS 2009 | http://poker.cs.ualberta.ca/publications/AAMAS09-abstraction.pdf |
| S09 | Schnizlein, Bowling, Szafron, "Probabilistic State Translation in Extensive Games with Large Action Sets", IJCAI 2009 | https://webdocs.cs.ualberta.ca/~bowling/papers/09ijcai-nolimit.pdf |
| H11 | Hawkin, Holte, Szafron, "Automated Action Abstraction of Imperfect Information Extensive-Form Games", AAAI 2011 | https://ojs.aaai.org/index.php/AAAI/article/view/7880 |
| H12 | Hawkin, Holte, Szafron, "Using Sliding Windows to Generate Action Abstractions in Extensive-Form Games", AAAI 2012 | https://ojs.aaai.org/index.php/AAAI/article/view/8401 |
| B14 | Bard, Johanson, Bowling, "Asymmetric Abstractions for Adversarial Settings", AAMAS 2014 | https://www.cs.ualberta.ca/~games/poker/publications/2014-aamas-asymmetric-abstractions.pdf |
| BS15 | Brown & Sandholm, "Simultaneous Abstraction and Equilibrium Finding in Games", IJCAI 2015 | https://www.ijcai.org/Abstract/15/075 |
| RL-CFR | Li, Fang, Huang, "RL-CFR: Improving Action Abstraction for Imperfect Information Extensive-Form Games with Reinforcement Learning", ICML 2024 | https://arxiv.org/abs/2403.04344 |
| WEVA | Li & Huang, "Effective, Efficient, and General Information Abstraction for Imperfect-Information Extensive-Form Games", arXiv May 2026 | https://arxiv.org/abs/2605.10900 |
| KrwEmd | Fu et al., "KrwEmd: Revising the Imperfect-Recall Abstraction from Forgetting Everything", arXiv Nov 2025 | https://arxiv.org/abs/2511.12089 |
| FROI | Fu et al., "Beyond Outcome-Based Imperfect-Recall: Higher-Resolution Abstractions for Imperfect-Information Games", arXiv Oct 2025 | https://arxiv.org/abs/2510.15094 |

Our code read: `/Users/rg/Downloads/gpo-wt/blueprint/blueprint/README.md`, `src/abstraction.{h,cpp}`,
`src/tree.{h,cpp}`, `src/games.h`.

## 2. Lossless hand isomorphism (Waugh 2013)

What it is. Two hands are strategically identical if one is a suit relabeling of the other, and
within a betting round the order of the cards does not matter. Waugh gives an indexing function
that maps every hand to a dense integer in `[0, size)` with no gaps (optimal), plus an unindex
function that returns a canonical representative. The construction, in my words:

1. Split the hand into rounds (e.g. 2 hole cards, then 3 flop cards, then 1, then 1).
2. For each suit, record its "configuration": how many cards of that suit appear in each round.
   Sort suits by configuration so suit labels no longer matter.
3. For each suit, compute a colex index of the rank sets it holds in each round (ranks used in
   earlier rounds are removed before indexing later rounds, so the index is dense).
4. Suits that share the same configuration are interchangeable, so their per-suit indices are
   combined as a multiset (sorted) colex index instead of an ordered tuple.
5. Add an offset for the suit-configuration class. The result is the hand's index.

Sizes. I compiled the library (W13-code) and printed `hand_indexer_size` locally
(probe: `_src/abstraction/sz.c`):

| Indexer | Round | Size |
| --- | --- | ---: |
| perfect recall {2,3,1,1} | preflop | 169 |
| perfect recall {2,3,1,1} | flop | 1,286,792 |
| perfect recall {2,3,1,1} | turn | 55,190,538 |
| perfect recall {2,3,1,1} | river | 2,428,287,420 |
| imperfect recall {2,4} | turn (board unordered) | 13,960,050 |
| imperfect recall {2,5} | river (board unordered) | 123,156,254 |

The four perfect-recall numbers match the counts printed in Pluribus-SM (abstraction section) and J13. W13's
Table 1 shows earlier indexers producing 1.22x to 3.50x more indices than the optimal one
(W13, Table 1).

Why it matters for us. Libratus's "55 million" turn hands and "2.4 billion" river hands
(Libratus, p. 2) are exactly these perfect-recall counts. If the turn and river bucket tables are
keyed by the unordered-board index, they only need 13,960,050 and 123,156,254 entries.

API (W13-code, `src/hand_index.h`): `hand_indexer_init(rounds, cards_per_round, &idx)`,
`hand_index_last`, `hand_index_all`, incremental `hand_index_next_round`, and `hand_unindex`.
Cards are `uint8` 0..51. License is an old BSD-style text with an attribution clause
(`LICENSE.txt` in the repo); it is permissive but we must keep the notice.

## 3. Distribution-aware clustering, EMD and OCHS (Johanson et al. 2013)

Key ideas, summarized:

* E[HS] (expected hand strength against a uniform random opponent hand after rolling out the
  board) collapses a whole distribution to one number. Hands with similar E[HS] can have very
  different shapes: pocket pairs have mass concentrated near their mean, suited connectors are
  bimodal (J13, Fig. 2). Distribution-aware abstraction compares the full histogram of
  end-of-game hand strength.
* For one-dimensional histograms, earth mover's distance (EMD) is computable in one pass. It
  equals the L1 distance between the two CDFs. J13 contrasts it with L2 and Kolmogorov-Smirnov,
  which measure how much mass moves but not how far.
* OCHS (opponent cluster hand strength): instead of one win probability against a uniform
  opponent, compute a vector of win probabilities against each of 8 opponent clusters. The 8
  clusters partition the 169 preflop classes and were themselves built with EMD clustering on
  preflop (J13, Table 1 gives the exact 169-to-8 assignment). Distance between OCHS vectors is L2.
  J13 uses OCHS on the river ("KO") because on the river every E[HS] histogram is a single spike,
  so EMD degenerates to an E[HS] difference.
* Imperfect recall: cluster every (hole, board) at each round independently, forgetting earlier
  buckets. This lets you redistribute buckets toward early rounds at equal game size.
* Clustering engineering: k-means with the triangle-inequality acceleration (Elkan), k-means++
  seeding, multiple restarts (J13, Sec. 4).

Results (two-player limit hold'em, so units are not directly comparable to no-limit):

* Every imperfect-recall agent beat every perfect-recall agent head to head; IR-KE-KO (EMD on
  rounds 1 to 3, OCHS on the river) was undefeated (J13, Table 3).
* CFR-BR exploitability, imperfect recall, 169-9000-9000-9000 buckets: PHS-PHS 94.841,
  PHS-KO 85.275, KE-PHS 80.557, KE-KO 64.820, KO-PHS 88.546, KO-KO 73.091 mbb/g (J13, Table 4).
  So swapping the river from percentile E[HS] to OCHS clustering cut it from 80.557 to 64.820
  with the same flop/turn method.
* Bucket redistribution at equal size (57.3M infosets): PR 10-10-10-10 gives 84.039, IR
  10-100-1000-10000 gives 89.7975, IR 169-9000-9000-9000 gives 64.820 mbb/g (J13, Table 5 and
  Table 2). The win comes from moving buckets to earlier rounds, which only imperfect recall
  allows.
* Compute used: 4 days of Public Chance Sampled CFR and 8 days of CFR-BR per abstraction on a
  48-core 2.2 GHz AMD machine (J13, Sec. 5).

Caveat from J13 and W09-path: the exploitability of an abstract-game equilibrium is not monotone
in abstraction refinement (abstraction pathologies), so evaluate with head-to-head play plus a
best-response style measure, not one alone.

## 4. Potential-aware imperfect-recall abstraction with EMD (Ganzfried & Sandholm 2014)

Problem with distribution-aware histograms: two flop hands can have the same histogram of final
(river) equity yet reach it along very different paths. GS14's example: TcQd on 7h9hQh versus
5c9d on 3d5d7d have EHS 0.683 and 0.679 and final-equity EMD 0.559, so the leading
distribution-aware method merges them, but the potential-aware EMD between them is 4.519
(comparable units) (GS14, Sec. 2.2).

Algorithm (GS14, Algorithm 1), in my words:

1. Cluster the last round (river) with any method (they used the J13 river method).
2. For round n going backwards (turn, then flop):
   a. Take the cluster means of round n+1 and compute the pairwise distance between every pair of
      next-round clusters, using round n+1's own distance function. This is the ground distance.
   b. For every hand x at round n, build a histogram over next-round clusters: entry i is the
      fraction of chance outcomes (next card) that send x into next-round cluster i.
   c. Run k-means on these histograms with EMD as the distance, where moving mass from cluster i
      to cluster j costs the ground distance from step a.
3. This is imperfect recall: each round is clustered over all hands, ignoring earlier buckets.

Fast approximate EMD (GS14, Algorithm 2): represent each point sparsely (a flop hand can only
reach as many turn clusters as there are turn cards, at most 47 entries of mass 1/47 each).
Precompute, for each next-round cluster, the list of the mean's nonzero clusters sorted by
ground distance. Then greedily move mass: for i = 1..Q, for each point entry j, take as much as
possible from the i-th closest mean cluster, add amount times distance to the cost. This is a
greedy transport, not exact EMD. Implementation pitfall: in the PDF's pseudocode the "else"
branch sets `targets[j] = 0` before subtracting `targets[j]` from `meanRemaining`; implement the
subtraction first or the mean's mass is never consumed.

Numbers:

* Exact EMD (Pele and Werman) averaged 11.4 ms per point-mean computation, the heuristic
  0.008 ms (GS14, Sec. 3).
* Heuristic average relative error vs exact potential-aware EMD: 0.1496 (+/- 0.0014); the prior
  distribution-aware exact EMD had 0.2084 (+/- 0.0014) relative to the potential-aware EMD
  (GS14, Sec. 4.2).
* Head-to-head in no-limit hold'em with 169-5000-5000-5000 buckets, changing only the flop
  abstraction: +2.58 +/- 1.56 mbb/h (small betting abstraction) and +2.22 +/- 1.28 mbb/h (large
  betting abstraction) over 20,000 duplicate matches each (GS14, Sec. 4.1).
* They used 25 k-means++ restarts and kept the lowest within-cluster sum of squares (GS14,
  Sec. 4.1). They used 64 cores for parallel k-means (GS14, Sec. 3).
* They applied it only on the flop. They state the turn looked computationally intractable even
  with the heuristic, citing about 1.3 million flop hands versus 55 million turn hands to cluster
  (GS14, Sec. 4.1). Note this is in perfect-recall-of-order counts; with an unordered turn board
  index the turn is 13,960,050 hands (W13-code), which is smaller.

Who used it afterwards: Pluribus's real-time search abstraction uses "an algorithm that
considers the future potential of each poker hand", combining potential-aware abstraction with
EMD clustering, 500 buckets per round, computed separately per flop (Pluribus-SM, section "Further details of the abstraction algorithm").
Libratus's card abstraction "was similar to" Baby Tartanian8's and Tartanian7's (Libratus, p. 2).

## 5. Bucket counts used by strong bots

| Agent | Preflop | Flop | Turn | River | Source |
| --- | --- | --- | --- | --- | --- |
| Pluribus blueprint (6-max) | 169 lossless | 200 | 200 | 200 | Pluribus-SM, abstraction section |
| Pluribus real-time search | lossless for the current round | 500 per later round, per flop | 500 | 500 | Pluribus-SM, abstraction section and "Abstraction and off-tree actions in subgames" |
| Libratus blueprint (HU) | lossless | lossless | 2.5 million (from 55 million) | 1.25 million (from 2.4 billion) | Libratus p. 2 |
| Tartanian7 (ACPC 2014 winner) | 169 | 60 public flop buckets x 500 private = 30,000 | 30,000 | 30,000 | T7 Sec. 5 |
| T7 shared-memory baseline | 169 | 5,000 | 5,000 | 5,000 | T7 Sec. 5 |
| GS14 experiments | 169 | 5,000 | 5,000 | 5,000 | GS14 Sec. 4.1 |
| RT14 bet-size experiment (HU) | 169 | 200 | 200 | 200 | RT14 Sec. on NLTH |
| J13 limit hold'em | 169 | 9,000 | 9,000 | 9,000 | J13 Table 2 |
| DeepStack value-net inputs | 169 (aux net) | 1,000 | 1,000 | n/a | DeepStack supplement |

Interesting detail: Pluribus-SM (blueprint computation section) says the second betting round averaged 6,434 real infosets
per abstract bucket, and that negative-regret pruning effectively refines the abstraction by
spending fewer samples on situations that strong play rarely reaches.

Game sizes for scale: T7's abstract game had 6.6e10 information sets and 1.8e11 infoset-actions,
solved with 1,153,200 core hours on 961 cores (T7 Sec. 5). Baby Tartanian8 used about 2 million
core hours (3,408 cores for about 600 hours), 1.6e14 nodes per abstraction, 16 TB of strategy
as doubles (BT8 Sec. 4). Pluribus's blueprint: 12,400 CPU core hours, under 512 GB, about $144
at spot rates (Pluribus, p. 4). Pluribus had 664,845,654 action sequences in the blueprint
action abstraction, of which 413,507,309 were reached; regret memory was allocated lazily on
first visit (Pluribus-SM, abstraction section).

## 6. Action abstraction

### What the top systems did

* Pluribus: between 1 and 14 raise sizes per decision point, all pot fractions, chosen by hand
  from sizes earlier Pluribus versions used with significant probability. Very fine on preflop,
  coarser on the flop. On turn and river: first raise in a round is 0.5x pot, 1x pot, or all-in;
  later raises are 1x pot or all-in. Fold and call always included when legal. Search uses 1 to 6
  raise sizes, "typically no more than five" (Pluribus-SM, abstraction section and "Abstraction and off-tree actions in subgames").
* Libratus: mostly nice pot fractions or multiples, roughly taken from the most common sizes of
  prior top ACPC bots; some early-tree sizes were set by the RT14 parameter optimizer. Overnight,
  it added the k = 3 opponent bet sizes that were most frequent and furthest from existing sizes
  ("self-improver"). During play it perturbed all of its own bet sizes by a random 0 to 8 percent
  (Libratus pp. 2, 5 and notes 49, 54).
* DeepStack lookahead trees (per round, first action / second action / remaining):
  preflop F C 1/2P P A / F C 1/2P P 2P A / F C P A; flop and turn F C 1/2P P A / F C P A /
  F C P A; river F C 1/2P P 2P A for the first two actions, then F C P A (DeepStack supplement,
  Table 4).
* Baby Tartanian8: asymmetric action abstraction, more actions for the opponent than for itself,
  sizes chosen by looking at which actions smaller agents' equilibria used most (BT8 Sec. 2;
  idea from B14).

### How bet-size choice affects exploitability

* GS13 paradox: in no-limit Kuhn with stack n = 100, replacing the pot bet with the "optimal"
  0.4 pot bet made deterministic arithmetic translation go from 0.301 to 3.714 exploitability.
  The bet size minimizing exploitability depended heavily on the translation mapping (for n = 100
  it was 71.5 pot for Det-psHar and 29.8 for Det-Geo) (GS13, Sec. on Kuhn, Tables 4 and 5).
  Lesson: include defensive sizes (sizes the opponent might use, even if we never do) in the
  opponent's side of the tree, not only the sizes we want to play.
* RT14: in a 169-200-200-200 HU abstraction (about 1.4 million infosets) with the ACPC 2012
  betting tree, gradient-based optimization of the first-action raise converged to 0.77 +/- 0.01
  pot from four initializations; a sanity sweep over {0.5, ..., 1.0} found 0.8 best, then 0.7
  (RT14, NLTH experiment). In Leduc it found (1.69, 8.56) as the two-round bet sizes (RT14).
* LBR on real ACPC bots: lower bounds on exploitability of 4,675 (Hyperborean 2014), 4,020
  (Slumbot 2016), 3,302 (Act1 2016) mbb/g, versus 750 for always folding (DeepStack Table 1,
  LBR Table 3). LBR's richest action set was 56 bets: fold, call, all-in, plus pot fractions
  0.05 x 1.15^k for k = 0..54 (LBR). Most of the exploitation came from just a pot bet ("fcpa"
  row) and LBR concluded that card abstraction caused more exploitability than betting
  abstraction for these bots.
* LBR on a bot with no card abstraction and a sparse fold/call/pot/all-in tree (100 BB stacks):
  full best response inside that same betting tree found 90 mbb/h, but with hard translation LBR
  won 2,403 mbb/h using 56 bets on the last two rounds, 1,849 mbb/h using only fold, call,
  min-bet, 2x, 4x, 8x pot and all-in; sampled soft translation still lost 1,981 +/- 224 (LBR,
  "Full cards"). That strategy needed almost 2 TB and about 14 CPU years (DeepStack supplement).
  Lesson: a coarse betting tree plus translation is very exploitable; small bets (min-bets) and
  large overbets are the usual attack.
* Libratus showed nested subgame solving cut exploitability by more than an order of magnitude
  relative to the leading action translation in a test game (Libratus, Table 2 discussion).
* W09-path: refining an abstraction (cards or actions) can make the full-game strategy worse.

### Automated action abstraction (for the paper's related work, and maybe a cheap win)

* H11 / H12: treat bet size as a continuous parameter, adjust it with regret-style updates or a
  sliding window during equilibrium finding; shown in no-limit Leduc.
* RT14: gradient descent on bet sizes with regret transfer (warm start after changing payoffs),
  with local optimality guarantees.
* BS15: start coarse and add actions during equilibrium finding without restarting.
* RL-CFR (ICML 2024): an RL policy picks the action abstraction per public state before a
  CFR solve; reported +64 +/- 11 mbb/hand over their ReBeL replication and +84 +/- 17 over
  Slumbot in HUNL (RL-CFR abstract).
* Pluribus's practical method: train with many candidate sizes, keep the sizes the strategy
  actually uses (Pluribus-SM, abstraction section). This is the cheapest one for us.

## 7. Action translation

Setup (GS13): the abstraction has sizes A_0 < ... < A_k at a decision point, all expressed as
fractions of the pot. The opponent bets x. Let A be the largest size <= x and B the smallest size
>= x. A translation mapping is f_{A,B}(x) = probability of treating x as A (else B).

Pseudo-harmonic mapping (GS13), derived from the clairvoyance game, where the equilibrium calls a
bet of size x (pot fraction) with probability 1/(1+x):

    f_{A,B}(x) = ((B - x) * (1 + A)) / ((B - A) * (1 + x))

Median (where f = 1/2): x* = (A + B + 2AB) / (A + B + 2). Randomized version (Rand-psHar): sample
A with probability f. Deterministic version: A if x < x*, else B.

Properties: satisfies boundary conditions, monotonicity, scale invariance; the randomized
version satisfies the axioms GS13 calls Action Robustness and Boundary Robustness; deterministic mappings are discontinuous at the
threshold (GS13, Sec. 8). A = 0 (a check) is allowed, so small bets can be mapped down to a check;
geometric mappings break at A = 0 (GS13).

Results: no-limit Leduc, fcpa abstraction, average exploitability Rand-psHar 0.463 versus
0.574 to 0.666 for the other six mappings (GS13, Table 6). Pluribus uses randomized
pseudo-harmonic for off-tree preflop raises within $100 of a blueprint size, deterministic
pseudo-harmonic to map subgame leaves back into the blueprint (Pluribus-SM, "Further details of the real-time search algorithm" and the continuation-strategy section); real-time
search handles larger deviations.

Implementation notes for our TS engine:

* Express x, A, B in the same unit the tree uses. Our tree's raise fraction is
  `increment / (pot + to_call)` and bet fraction is `bet / pot` (`tree.cpp`, `legal_actions`), so
  convert the opponent's real action the same way before mapping.
* Include check/call as A = 0 at each decision point; include all-in as the top size.
* After translating, the real pot and stacks differ from the abstract node's. Keep playing the
  abstract node's strategy but compute our own bet amounts from the real pot. Libratus and
  Pluribus avoid this drift by re-solving, which is the long-term fix (see `libratus-deepstack.md`
  and `pluribus.md` from the swarm).
* S09 introduced probabilistic ("soft") translation earlier; GS13 compares against it.

## 8. Imperfect recall: theory caveats worth one paragraph in the paper

* W09-IR: imperfect recall gave stronger agents than perfect recall in limit and no-limit
  hold'em at equal size (their program won the 2008 AAAI competition limit equilibrium and
  no-limit events). Some algorithms are not well defined and CFR loses its guarantees.
* J13 restates that CFR has no convergence proof in the imperfect-recall abstractions used in
  poker, but remains well defined and works in practice.
* Recent critiques (FROI arXiv 2510.15094, KrwEmd arXiv 2511.12089, same group) argue that
  forgetting all history loses value and propose keeping some history in the features; neither
  abstract reports numbers, so treat as unverified until reproduced.
* WEVA (arXiv 2605.10900, May 2026) clusters on expected values from a short CFR warm-up and
  reports up to over 80 percent lower exploitability than equity-based abstractions on three
  games (abstract only; games are not full HUNL as far as the abstract says, so unverified for
  hold'em).

## 9. Our current abstraction, read from the code

Source: `/Users/rg/Downloads/gpo-wt/blueprint/blueprint/src/abstraction.cpp`, `abstraction.h`,
`tree.cpp`, README.

* Preflop: 169 lossless classes. Matches the state of the art.
* Flop and turn: for each (hole, canonical board), a 50-bin histogram of river E[HS] against a
  uniform opponent over all runouts (1,081 on the flop, 46 on the turn), converted to a CDF, and
  clustered with Lloyd k-means under squared L2 on the CDF. This is J13-style distribution-aware
  clustering with an L2-on-CDF metric instead of EMD.
* River: 1-D k-means on E[HS] against a uniform opponent (ties half, exact card removal).
* Defaults 50/50/50 buckets, 50 bins; README tested 200/200/200 too.
* Centers fit on samples: 300 flops, 300 turns, 2,000 rivers (`AbsConfig`), 30 Lloyd iterations
  (60 on the river), one k-means++ run, no restarts.
* Isomorphism: board-only canonicalization over 24 suit permutations, then the hole cards are
  relabeled with the same permutation. Tables are `[canon_board][1326 combos]`: 1,755 flops,
  16,432 turns, 134,459 rivers. Lossless, but not the optimal index (it does not merge hole
  combos that are equivalent under the board's own stabilizer).
* River bucket table is `uint8` (max 255 buckets, otherwise per-deal EHS).
* Action abstraction presets: `tiny`, `small` (preflop 0.5x/1x pot raises, 3 raises; postflop
  bets 0.5x/1x, raise 1x, 2 raises), `medium` (preflop 0.5/1/2, 4 raises; postflop bets
  0.33/0.66/1/2, raises 0.66/1/2, 3 raises). Same size menu at every raise depth and for both
  players. No translation in the TS loader yet.

## 10. Gaps versus the state of the art, ranked

1. Bucket count is far below what strong bots used. 50 per postflop round versus 200 (Pluribus
   blueprint, RT14 HU experiments), 5,000 (GS14, T7 baseline), 30,000 (T7), millions (Libratus).
   J13 also shows that at a fixed budget it pays to put buckets early (169-9000-9000-9000 beat
   10-100-1000-10000). Action: build 200/200/200 first (README estimates about 30 hours on 4
   threads for the medium tree), then try 1,000 to 5,000 on the flop and turn on a rented box.
2. No potential-aware flop abstraction. GS14 is the method behind Pluribus's search buckets and
   gave +2.2 to +2.6 mbb/h at 5,000 buckets. Our README already lists it as the next step.
   Implementation for us: cluster the turn first (current turn features are fine), then for each
   flop hand build a sparse histogram over the 47 turn cards' turn buckets, and run k-means with
   EMD whose ground distance is the distance between turn cluster centers. For the turn, our
   river clusters are 1-D, so a potential-aware turn feature is essentially the current turn
   histogram; the gain is on the flop.
3. River uses plain E[HS]. J13's best river method is OCHS (8-D win probabilities vs 8 preflop
   opponent clusters, k-means under L2). In J13, IR KE-PHS to IR KE-KO cut CFR-BR exploitability
   from 80.557 to 64.820 mbb/g in limit hold'em. Implementation: in `river_ehs_all`, keep
   per-opponent-cluster counters (8 copies of `lower_with`/`group_with`) during the same sorted
   sweep. Cost is roughly 8x the current river sweep (my estimate).
4. Distance metric. We assign by squared L2 on CDFs. 1-D EMD is L1 on CDFs (J13). Since the mean
   of CDFs is the CDF of the mean histogram, we can keep the mean update and switch only the
   assignment step to L1 on CDFs. GS14 and J13 report EMD beating L2 on raw histograms; how much
   L2-on-CDF loses versus L1-on-CDF is unverified. Cheap to test.
5. k-means quality. One run, 30 iterations, centers from 300 sampled flops. GS14 used 25
   k-means++ restarts; J13 used restarts and Elkan acceleration. For the flop we can cluster the
   full population instead of a sample: 1,755 canonical flops x up to 1,176 hole combos, weighted
   by the orbit size already stored in `canon_weight`. Add restarts and keep the lowest inertia.
6. All-in disappears once `max_raises` is reached (`legal_actions` returns before adding it), so
   an opponent shove after the cap has no abstract counterpart. Allow all-in (and call) at every
   node regardless of the raise cap. (This is my reading of `tree.cpp`; no paper says it in these
   words, but Pluribus-SM says fold and call are always included and all-in is in every turn/river
   menu.)
7. Bet menu ignores raise depth and is symmetric. Pluribus uses different menus for the first
   raise and later raises in a round; BT8 used asymmetric abstractions (more opponent actions);
   GS13 and LBR show missing small bets and overbets get exploited through translation. Add, on
   the opponent's side only, a min-bet and a 2x to 3x overbet on each street.
8. No action translation in the TS engine. Implement randomized pseudo-harmonic (section 7).
9. No bet-size selection procedure. Cheapest: train a small-card-abstraction run with a wide
   menu, then keep sizes with meaningful probability (Pluribus method). Optional: RT14 gradient
   method on the preflop open size.
10. Index and storage. River table is `uint8`; switch to `uint16` before going past 255 river
    buckets. Optionally key turn and river tables by Waugh's unordered-board index: 13,960,050
    and 123,156,254 entries instead of our 21,788,832 and 178,292,634 (my arithmetic: 16,432 x
    1,326 and 134,459 x 1,326).
11. No per-flop abstraction for search. Pluribus search uses 500 buckets per later round computed
    separately for each flop. Needed once we add depth-limited search; not needed for the
    blueprint.
12. Evaluation setup for abstractions. J13 recommends CFR-BR, which needs full-game traversal.
    For us: (a) compare abstraction variants head to head in duplicate after equal training time,
    (b) implement LBR with full card information as the paper's exploitability lower bound
    (DeepStack and LBR both used it), (c) sanity-check each technique on a small game where exact
    best response is cheap (Leduc already exists in our trainer).

## 11. Suggested build order (cheap to expensive)

1. All-in always legal; opponent-side min-bet and overbet (tree change, hours).
2. L1-on-CDF assignment, full-population flop clustering with orbit weights, 10 to 25 k-means++
   restarts (abstraction.cpp change, hours; rebuild minutes).
3. OCHS river features (one day; table build time grows roughly 8x on the river by my estimate).
4. Potential-aware flop with sparse greedy EMD (GS14 Algorithm 2, with the order fix) or exact
   EMD via a small transport solver since each point has at most 47 nonzeros (one to three days).
5. 200/200/200 blueprint, then scale buckets on rented hardware.
6. Pseudo-harmonic translation in TS (half a day).
7. LBR evaluator (one to two days).

## 12. Pitfalls

* Abstraction pathologies: finer is not always better (W09-path). Always A/B test.
* Don't trust a single head-to-head number; J13 found intransitivities and weak correlation
  between head-to-head and exploitability.
* GS14 Algorithm 2 pseudocode order bug noted above.
* Using sizes that are "optimal" in equilibrium can raise exploitability when the opponent uses
  other sizes (GS13). Keep defensive sizes on the opponent side.
* Imperfect recall breaks CFR's guarantees; monitor convergence empirically.
* Sampling bias: when fitting centers on sampled boards, sample raw boards uniformly (our code
  does) or weight canonical boards by orbit size.
* Library license (W13-code) has an attribution clause; keep it if we vendor the code.

## 13. Open-source code worth reading

* https://github.com/kdub0/hand-isomorphism (C, BSD-style with attribution): optimal indexer.
  Compiles with clang on this Mac (verified locally).
* https://github.com/ericgjackson/slumbot2019 (C++, MIT): CFR+, MCCFR, k-means bucketing tools
  (`build_kmeans_buckets`, `build_rollout_features`), betting-tree builder, resolving, real-game
  best response.
* https://github.com/krukah/robopoker (Rust, MIT): potential-aware imperfect-recall abstraction
  with EMD via Sinkhorn/Greenkhorn, pseudo-harmonic translation. Its README lists 16 vCPU /
  120 GB for abstraction building and reports -13.1 bb/100 against Slumbot over 86.0K hands
  (README claims, not independently checked).
* https://github.com/fedden/poker_ai (Python, GPL-3, archived July 2024): Pluribus-inspired, only
  a 20-card deck supported. Reference only.
