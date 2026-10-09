// ============================================================
// search.h: real-time search on top of the blueprint (PLAN.md M5).
//
//   * build_from_blueprint copies the blueprint's betting subtree from the
//     start of the current round into a subgame (rt::Game). Street changes
//     become chance nodes (solve to the end of the game: turn and river) or
//     depth-limit leaves (flop).
//   * Depth-limit leaves follow Pluribus (Brown and Sandholm 2019, Science,
//     supplementary "depth-limited search"): each player still in the hand
//     picks one of k = 4 continuation strategies for the rest of the game,
//     the blueprint and three biased copies in which the probability of
//     folding, of calling (or checking), or of raising (any bet, raise or
//     all-in) is multiplied by `bias` (5 in Pluribus) and renormalized, at
//     every later decision of that player. Both players choose (Modicum let
//     only the opponent choose). Leaf payoffs for every pair of choices and
//     every pair of hands are computed exactly by enumerating all runouts,
//     or estimated from sampled runouts (rollouts) for hold'em.
//   * Beliefs: each player's range at the start of the round is the prior
//     (uniform over the hands that do not touch the board) times that
//     player's blueprint reach probability along the actual line
//     ("unsafe" search from the start of the round, as in Pluribus).
//   * The searcher's own actions already taken in this round are frozen for
//     its actual hand (Pluribus: the strategy for the hand it holds is fixed
//     on the actions it already took).
// ============================================================
#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>

#include "subgame.h"
#include "tree.h"

namespace bp {
struct Abstraction;
namespace rt {

struct BpView {
  const BettingTree* tree = nullptr;
  // Normalized blueprint strategy at slot base (nact entries).
  std::function<void(uint64_t base, int nact, double* out)> policy;
  // Card-abstraction bucket of a hand at `street`, given the board cards
  // dealt so far IN DEAL ORDER (prefix lengths given by board_len).
  std::function<int(const Hand&, const std::vector<int>& board, int street)> bucket;
  std::function<int32_t(const Hand&, const std::vector<int>&)> strength;
  int deck = 52, cards_per_hand = 2;
  std::vector<int> board_len;  // public cards visible on each street
};

// Copy the blueprint subtree rooted at blueprint node `root` (a decision
// node) into g. `board` = public cards at that node, in deal order. Returns,
// for depth-limited builds, the blueprint node of every leaf (g.leaves is
// resized to match; values are filled by build_leaf_values).
std::vector<uint32_t> build_from_blueprint(Game& g, const BpView& bv, uint32_t root, const std::vector<int>& board,
                                           bool depth_limited);

// Biased continuation strategy: choice 0 = blueprint, 1 = fold x bias,
// 2 = check/call x bias, 3 = bet/raise/all-in x bias (renormalized).
void continuation(const BettingTree& t, const Node& n, const double* sigma, int choice, double bias, double* out);

// Fill g.leaves[l].V for leaf blueprint nodes `leaf_bp`. `board` is the
// subgame's board (deal order). rollouts == 0 enumerates every runout
// exactly; otherwise that many uniformly sampled runouts are averaged per
// hand pair. Run after g.finalize() (needs compat).
void build_leaf_values(Game& g, const BpView& bv, const std::vector<uint32_t>& leaf_bp, const std::vector<int>& board,
                       int k, double bias, int rollouts, uint64_t seed, int threads);

// Blueprint reach of each hand for player p along the path root -> node.
std::vector<double> blueprint_reach(const BpView& bv, const std::vector<Hand>& hands, int p, uint32_t node,
                                    const std::vector<int>& board);

// First node of the betting round containing blueprint node `node`.
uint32_t round_start(const BettingTree& t, uint32_t node);

// Hold'em view over a trained policy table (pol[slot]) and abstraction.
BpView holdem_view(const BettingTree& t, const Abstraction& abs, const std::vector<float>& pol);

// CLI entry points (dispatched from main.cpp).
int search_cli(const std::string& cmd, const std::map<std::string, std::string>& kv, const BettingTree& tree,
               const Abstraction& abs, const std::vector<float>& pol);
int subgame_cli(const std::map<std::string, std::string>& kv);

}  // namespace rt
}  // namespace bp
