// ============================================================
// tree.h: the abstract betting tree, shared by every game we train.
//
// A game here is (betting tree) x (deal). The betting tree is the public
// action structure: who acts, what abstract actions exist, what each player
// has committed. A deal supplies, for each player and street, the card
// bucket that player observes, plus who wins a showdown. An infoset is then
// (tree node, bucket of the acting player at that street): the standard
// imperfect-recall layout used by Pluribus-era blueprints.
//
// Because Kuhn, Leduc and no-limit hold'em all reduce to this shape, the
// MCCFR trainer in mccfr.h is literally the same code for all three; Kuhn
// and Leduc are the correctness gate for the hold'em run.
//
// Storage: decision node n owns a contiguous block of
// buckets(street) * nact regret slots starting at n.slot, laid out
// [bucket][action]. Children of a node are contiguous in `nodes`.
// ============================================================
#pragma once

#include <string>
#include <vector>

#include "common.h"

namespace bp {

enum NodeType : uint8_t { DECISION = 0, FOLD = 1, SHOWDOWN = 2 };
enum ActKind : uint8_t { ACT_ROOT = 0, ACT_FOLD, ACT_CHECK, ACT_CALL, ACT_BET, ACT_RAISE, ACT_ALLIN };
constexpr int MAX_ACTIONS = 16;

struct Node {
  uint8_t type = DECISION;
  uint8_t player = 0;  // actor (DECISION) or folder (FOLD)
  uint8_t street = 0;
  uint8_t nact = 0;
  uint8_t act_kind = ACT_ROOT;  // action that led INTO this node
  uint8_t raises = 0;           // bets + raises so far on this street
  uint16_t frac_milli = 0;      // pot fraction x1000 for BET / RAISE
  uint32_t child = 0;           // index of the first child
  uint32_t parent = 0;
  uint64_t slot = 0;            // first regret slot (DECISION only)
  int32_t contrib[2] = {0, 0};  // chips committed so far (incl. blinds/antes)
};

struct StreetRules {
  bool limit = false;
  int32_t limit_bet = 0;           // fixed bet/raise size (limit games)
  std::vector<float> bet_fracs;    // pot fractions when not facing a bet
  std::vector<float> raise_fracs;  // pot fractions when facing a bet
  bool allin = true;               // offer an all-in action (no-limit)
  int max_raises = 3;              // bets + raises allowed on the street
  int first_player = 0;
};

struct TreeConfig {
  std::string name;
  int nstreets = 4;
  int32_t stack = 10000;           // starting stack, both players
  int32_t blind[2] = {50, 100};    // initial commitments (blinds or antes)
  int32_t min_bet = 100;           // minimum bet / raise increment
  StreetRules street[4];
  std::string describe() const;    // canonical text, used for hashing + export
};

// Parse "0.5,1,2" into fractions.
std::vector<float> parse_fracs(const std::string& s);

struct BettingTree {
  TreeConfig cfg;
  std::vector<Node> nodes;
  int buckets[4] = {1, 1, 1, 1};
  uint64_t num_slots = 0;
  void build(const TreeConfig& c, const int* buckets_per_street);
  const Node& child(const Node& n, int a) const { return nodes[n.child + a]; }
  // Short token for the action that led into node i: f k c b0.5 r1 a.
  std::string token(uint32_t i) const;
  // Space-separated action tokens from the root to node i.
  std::string history(uint32_t i) const;
  // Follow tokens from the root; returns -1 if a token is not in the tree.
  int64_t find(const std::vector<std::string>& toks) const;
  void print_stats(FILE* out) const;
};

// Utility for player p at a terminal node. winner: 0/1, or 2 for a tie.
inline double terminal_utility(const Node& n, int p, int winner) {
  int o = 1 - p;
  if (n.type == FOLD) return n.player == p ? -double(n.contrib[p]) : double(n.contrib[o]);
  if (winner == 2) return 0.5 * double(n.contrib[o] - n.contrib[p]);
  return winner == p ? double(n.contrib[o]) : -double(n.contrib[p]);
}

// Named configurations.
TreeConfig kuhn_config();
TreeConfig leduc_config();
// No-limit hold'em presets: "tiny", "small", "medium" (see tree.cpp).
TreeConfig holdem_config(const std::string& preset);

}  // namespace bp
