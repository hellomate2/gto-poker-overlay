// ============================================================
// subgame.h: vectorized range-vs-range subgame solver for real-time search
// (PLAN.md M4 and the solver half of M5).
//
// A subgame is a public tree (decision, fold, showdown, chance and
// depth-limit leaf nodes) plus, for each player, a list of private hands
// with prior weights. Every player infoset is (public node, own hand), so
// cards are lossless inside the subgame. Each CFR iteration walks the public
// tree once per player, carrying the opponent's reach as a vector over the
// opponent's hands and returning the traverser's counterfactual values as a
// vector over its own hands (Johanson et al. 2012 public-tree CFR; the same
// scheme as src/core/solver/postflop-cfr.ts, ported and extended).
//
// Payoff convention (identical to the TS solver so numbers compare 1:1):
// the subgame starts with pot0 chips in the middle and each player has put
// c[p] chips in since. A player's payoff is the net chips from the subgame's
// start, counting pot0 as up for grabs:
//   p folded            -c[p]
//   opponent folded     pot - c[p]            (pot = pot0 + c[0] + c[1])
//   showdown            share * pot - c[p]    (share 1, 1/2 or 0)
// so the two payoffs always sum to pot0 (constant-sum). Exploitability is
// (BR_0 + BR_1 - pot0) / 2, where BR_p is p's best-response value against
// the other player's average strategy (the TS solver's definition).
//
// Card removal. Both players' hands are card masks; the joint chance weight
// of (i, j) is w0[i] w1[j] compat(i, j). Sums of opponent reach over the
// hands compatible with my hand use inclusion-exclusion over cards, O(n).
// Showdowns on a 5-card board use a strength sort precomputed per board:
// one ascending and one descending sweep give, per hand, the compatible
// opponent reach that it beats and that beats it, so a showdown costs
// O(n + 52) per node instead of O(n^2) (Johanson et al. 2011, "Accelerating
// best response calculation", section 4). Showdowns before the river (all-in
// on the flop or turn, or the TS single-street turn leaf) use an exact
// equity matrix per board instead.
//
// Chance nodes deal one public card. Given both hands, the next card is
// uniform over the cards not on the board and not in either hand, so every
// child has weight 1 / (deck - |board| - 2 * cards_per_hand) for each
// compatible pair, and hands that contain the dealt card drop out of that
// child.
//
// Depth-limit leaves (M5, Pluribus / Brown, Sandholm and Amos 2018): at a
// leaf each player picks one of k continuation strategies for the rest of
// the game without seeing the other's pick; the pair (a, b) and the two
// hands fix the payoff V[a][b][i][j] (precomputed by the caller, see
// search.h). Both choices are learned by the same regret minimizer as the
// betting actions.
//
// Algorithms. Discounted CFR (Brown and Sandholm 2019) with parameters
// (alpha, beta, gamma); (1.5, 0.5, 2) matches the TS solver. CFR+ with
// linear averaging after a delay (Tammelin 2014). Updates alternate
// (player 0 then player 1 each iteration).
// ============================================================
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "common.h"

namespace bp {
namespace rt {

enum SType : uint8_t { S_DEC = 0, S_FOLD, S_SHOW, S_CHANCE, S_LEAF };

struct SNode {
  uint8_t type = S_DEC;
  uint8_t player = 0;  // actor (S_DEC) or folder (S_FOLD)
  int nact = 0;        // children of S_DEC / S_CHANCE
  double c[2] = {0, 0};
  double pot = 0;      // pot0 + c[0] + c[1]
  int board = 0;       // index into Game::boards (public cards at this node)
  int first = 0;       // first child index (children are contiguous)
  size_t off = 0;      // regret / strategy offset (S_DEC): [action * n_actor + hand]
  int leaf = -1;       // S_LEAF: index into Game::leaves
  int bp = -1;         // blueprint node this node was copied from (or -1)
  int parent = -1;
  std::string label;   // action that led here ("" at the root)
  int deal = -1;       // card dealt by the parent chance node
};

struct Hand {
  int c[2] = {-1, -1};
  int nc = 0;
  uint64_t mask = 0;
};

struct Board {
  std::vector<int> cards;
  uint64_t mask = 0;
  // Showdown data (built on demand by Game::prepare_showdowns):
  bool sweep = false;            // strength-sort showdown (complete board)
  std::vector<int32_t> str[2];   // strength per hand, -1 if blocked
  std::vector<int> asc[2];       // unblocked hands sorted by strength
  // The same order, packed for the sweep: strength, cards (absent cards map
  // to slot 62 when the hand is the opponent's, 63 when it is mine), index.
  struct SortedHand {
    int32_t str;
    uint8_t oc0, oc1, mc0, mc1;
    int32_t idx, same;
  };
  std::vector<SortedHand> packed[2];
  bool equity = false;           // equity-matrix showdown (incomplete board)
  std::vector<double> share;     // [i * H1 + j]: p0's showdown share, 0 if incompatible
};

// Payoffs at a depth-limit leaf for every (choice of p0, choice of p1, hand
// of p0, hand of p1), in the subgame's convention for player 0. Player 1's
// payoff is pot0 * compat(i, j) - V (constant-sum).
struct LeafValues {
  int k[2] = {1, 1};
  std::vector<double> V;  // [((a * k1 + b) * H0 + i) * H1 + j]
  size_t at(int a, int b, int i, int j, int H0, int H1) const {
    return ((size_t(a) * k[1] + b) * H0 + i) * size_t(H1) + j;
  }
};

struct Game {
  int deck = 52;
  int cards_per_hand = 2;  // 0 (abstract toy games), 1 (Leduc) or 2 (hold'em)
  double pot0 = 0;
  std::vector<Hand> hands[2];
  std::vector<double> w[2];        // prior weights, each normalized to sum 1
  std::vector<int> same[2];        // index of the identical hand in the other list, or -1
  std::vector<SNode> nodes;        // nodes[0] is the root
  std::vector<Board> boards;
  std::vector<LeafValues> leaves;
  std::vector<float> compat;       // [i * H1 + j], built by finalize()
  // Showdown strength of a hand on a complete board (higher wins), or -1 if
  // the hand uses a board card. Required when the tree has sweep showdowns.
  std::function<int32_t(const Hand&, const std::vector<int>&)> strength;
  // For boards that are not complete (fewer than `full_board` cards), the
  // showdown is the average over all completions (equity matrix).
  int full_board = 5;
  size_t num_slots = 0;            // regret slots (sum over S_DEC of nact * n_actor)

  int n(int p) const { return int(hands[p].size()); }
  int add_board(const std::vector<int>& cards);
  // Set masks, normalize weights, link identical hands, allocate slots,
  // build compat and showdown data. Call once after the tree is complete.
  void finalize();
  double joint_mass() const;  // sum_ij w0 w1 compat
  std::string line(int node) const;  // action labels from the root
  int find(const std::vector<std::string>& labels) const;  // -1 if absent
};

struct SolverConfig {
  enum Algo { DCFR, CFRPLUS } algo = DCFR;
  double alpha = 1.5, beta = 0.5, gamma = 2.0;  // DCFR (TS defaults)
  int cfrp_delay = 0;                          // CFR+: average weight max(0, t - delay)
  int threads = 1;                             // parallel chance-node children
};

class Solver {
 public:
  Solver(Game& g, const SolverConfig& cfg);
  void iterate();
  int iterations() const { return iters_; }
  // Average strategy of the actor at decision node `node` for hand h.
  void average(int node, int h, double* out) const;
  void current(int node, int h, double* out) const;
  // Leaf choice probabilities (average) of player p's hand h at leaf node.
  void leaf_average(int node, int p, int h, double* out) const;
  // Force hand h of the actor at `node` to take action a (frozen action).
  void freeze(int node, int h, int a);
  // Expected value (subgame convention) of player p under the averages, or
  // with p best-responding. Normalized by the joint chance mass.
  double value(int p, bool best_response);
  double exploitability();  // (BR0 + BR1 - pot0) / 2, chips
  // Per-hand values of player p (cfv divided by compatible opponent mass).
  std::vector<double> hand_values(int p, bool best_response);
  // External strategy hook: when set, value()/exploitability() evaluate this
  // profile instead of the solver's averages (used to score a strategy that
  // was computed elsewhere, e.g. by the TS solver).
  std::function<void(int node, int h, double* out)> external;

  const Game& game() const { return g_; }

 private:
  Game& g_;
  SolverConfig cfg_;
  int iters_ = 0;
  std::vector<double> R_, S_;
  std::vector<size_t> leaf_off_[2];  // per leaf: offset into LR_/LS_ for player p
  std::vector<double> LR_, LS_;
  std::vector<int> frozen_node_, frozen_hand_, frozen_act_;
  bool in_parallel_ = false;
  std::vector<double> chance(int ni, int p, double norm, const std::function<std::vector<double>(int)>& child);
  // per-iteration discount factors
  double dpos_ = 1, dneg_ = 1, dstrat_ = 1, wavg_ = 1;

  void regret_match(const double* R, int na, int n, double* out) const;
  void node_current(int ni, std::vector<double>& sig) const;
  void node_average(int ni, std::vector<double>& sig) const;
  void apply_frozen(int ni, std::vector<double>& sig) const;
  std::vector<double> cfr(int ni, int p, const std::vector<double>& ropp);
  std::vector<double> eval(int ni, int p, const std::vector<double>& ropp, bool br);
  void terminal(int ni, int p, const std::vector<double>& ropp, std::vector<double>& out);
  void mass(int p, const std::vector<double>& ropp, std::vector<double>& out);
  void leaf_values(int ni, int p, const std::vector<std::vector<double>>& rb, std::vector<std::vector<double>>& cv) const;
  std::vector<double> chance_child_reach(int child, int q, const std::vector<double>& r) const;
};

// ---- tree builders ------------------------------------------------------------

// The TS solver's single-street tree (src/core/solver/postflop-cfr.ts,
// buildSubgameTree + aggressiveActions), ported rule for rule so a spot
// exported from TS builds the identical tree. Hero is player 0 and acts at
// the root. On a board of fewer than 5 cards the showdown leaf is the
// all-runouts equity average, as in TS.
struct TsTreeParams {
  double starting_pot = 0, effective_stack = 0, to_call = 0;
  bool hero_ip = false;
  int prior_aggressions = 0;
  std::vector<double> bet_fracs, raise_fracs;
  int max_aggressions = 3;
  double allin_max_spr = 4, allin_threshold = 0.8;
};
void build_ts_tree(Game& g, const TsTreeParams& p, const std::vector<int>& board);

// Builder helpers for hand-written trees (toy games and tests).
int add_node(Game& g, const SNode& n);

// Hold'em hand strength via the 7-card evaluator (board must have 5 cards).
int32_t holdem_strength(const Hand& h, const std::vector<int>& board);

}  // namespace rt
}  // namespace bp
