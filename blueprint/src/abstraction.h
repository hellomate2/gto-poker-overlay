// ============================================================
// abstraction.h: card abstraction (imperfect recall, one bucket per street).
//
//   preflop  lossless: 169 strategically distinct starting hands.
//   flop     k-means over "distribution-aware" features: for each
//            (hole, flop) the histogram of river EHS over all 1,081 turn+river
//            runouts, clustered as CDFs under L2 (a cheap stand-in for the 1-D
//            earth mover's distance, which is L1 between CDFs).
//   turn     same, histogram of river EHS over the 46 possible rivers.
//   river    1-D k-means on EHS (expected hand strength vs one uniformly
//            random opponent hand, ties count half, card removal exact).
//
// Board suit isomorphism: a flop/turn board is mapped to the lexicographically
// smallest relabeling of its suits (24 permutations). Bucket tables are
// indexed [canonical_board][combo_index(permuted hole)], so they are exact
// lookups with no hashing. Table sizes: 1,755 canonical flops and 16,432
// canonical turns (counts asserted in the test binary) times 1,326 combos.
//
// River buckets: a river bucket is a pure function of EHS, so only the
// cluster boundaries are stored on disk. At load time the trainer expands
// them into a one-byte table over the 134,459 canonical rivers x 1,326
// combos (178 MB, about 3 s on 4 threads) because computing EHS per deal
// (1,081 evaluations, ~5 us on random boards) would otherwise dominate the
// cost of an MCCFR iteration. river_ehs_pair() remains the reference path
// (used when the table is not built, and by the tests).
// ============================================================
#pragma once

#include <array>
#include <memory>
#include <string>
#include <vector>

#include "common.h"

namespace bp {

// Suit permutations: PERMS[p][old_suit] = new_suit.
extern const uint8_t SUIT_PERMS[24][4];
inline int perm_card(int c, int p) { return make_card(rank_of(c), SUIT_PERMS[p][suit_of(c)]); }

// Canonical-board index for k-card boards (k = 3, 4 or 5).
struct BoardIso {
  int k = 0;
  std::vector<uint32_t> raw_to_canon;  // colex(raw sorted board) -> canonical id
  std::vector<uint8_t> raw_perm;       // suit permutation that canonicalizes it
  std::vector<std::array<uint8_t, 5>> canon_cards;  // representative (sorted)
  std::vector<uint32_t> canon_weight;  // number of raw boards in the orbit
  void build(int k);
  size_t num_canon() const { return canon_cards.size(); }
  // Canonical id of an unordered board; writes the permutation used.
  uint32_t lookup(const int* board, int& perm) const;
};

uint32_t colex_index(const int* sorted_cards, int k);

// Preflop class 0..168: index = row*13 + col on the usual 13x13 grid with
// ranks 0..12 (2..A): pairs on the diagonal (r, r), suited at
// (row = high, col = low), offsuit at (row = low, col = high).
inline int preflop_class(int a, int b) {
  int ra = rank_of(a), rb = rank_of(b);
  int hi = ra > rb ? ra : rb, lo = ra > rb ? rb : ra;
  if (hi == lo) return hi * 13 + hi;
  if (suit_of(a) == suit_of(b)) return hi * 13 + lo;
  return lo * 13 + hi;
}

// EHS of every hole combo on a 5-card board. out[combo] = -1 if the combo
// intersects the board. Exact (enumerates all 990 opponent hands per combo).
void river_ehs_all(const int board[5], float* out);

// EHS of two specific (disjoint) holes on a 5-card board.
void river_ehs_pair(const int board[5], const int h0[2], const int h1[2], float out[2]);

struct AbsConfig {
  int flop_k = 50, turn_k = 50, river_k = 50;
  int bins = 50;               // histogram bins on [0, 1]
  int sample_flops = 300;      // boards sampled to fit flop centers
  int sample_turns = 300;      // boards sampled to fit turn centers
  int sample_rivers = 2000;    // boards sampled to fit river centers
  int kmeans_iters = 30;
  uint64_t seed = 7;
  int threads = 4;
  // ---- v2 options (abs_v2.h). Defaults reproduce the original abstraction
  // and leave id() unchanged, so old caches and checkpoints still load.
  std::string flop_mode = "da";   // "da" distribution-aware | "pa" potential-aware (GS14)
  std::string river_mode = "ehs"; // "ehs" 1-D EHS | "ochs" 8-D opponent-cluster hand strength (J13)
  int restarts = 1;               // k-means restarts for the pa flop
  int pa_sample = 200000;         // weighted flop hands the pa centers are fit on
  bool waugh_lookup = false;      // runtime only: read buckets via Waugh-indexed tables
  std::string id() const;      // stable file-name fragment
};

struct WaughTables;

struct Abstraction {
  AbsConfig cfg;
  BoardIso flop_iso, turn_iso;
  std::vector<uint16_t> flop_bucket;  // [canon_flop * 1326 + combo]
  std::vector<uint16_t> turn_bucket;  // [canon_turn * 1326 + combo]
  std::vector<float> river_centers;   // ascending
  std::vector<float> river_bounds;    // midpoints between consecutive centers
  BoardIso river_iso;                 // built by prepare_river_table()
  std::vector<uint8_t> river_bucket;  // [canon_river * 1326 + combo]
  std::shared_ptr<WaughTables> waugh; // set by --waugh-lookup (abs_v2.h)

  int num_buckets(int street) const {
    return street == 0 ? 169 : street == 1 ? cfg.flop_k : street == 2 ? cfg.turn_k : cfg.river_k;
  }
  int flop(const int hole[2], const int board[3]) const;
  int turn(const int hole[2], const int board[4]) const;
  int river_from_ehs(float ehs) const;
  bool has_river_table() const { return !river_bucket.empty() || waugh_river; }
  bool waugh_river = false;
  int river(const int hole[2], const int board[5]) const;
  // Expand river_bounds into the river lookup table (needs river_k <= 255).
  void prepare_river_table(int threads, bool verbose = true);

  void build(const AbsConfig& c, bool verbose = true);
  bool save(const std::string& path) const;
  bool load(const std::string& path);
  // Loads from cache_dir if present, otherwise builds and saves.
  void load_or_build(const AbsConfig& c, const std::string& cache_dir);
  std::string path_in(const std::string& cache_dir) const;
};

// Weighted Lloyd k-means with k-means++ seeding (exposed for tests).
// X: n x d row-major, w: n weights (may be null). Returns k x d centers.
std::vector<float> kmeans(const std::vector<float>& X, const std::vector<float>* w, size_t n, int d,
                          int k, int iters, uint64_t seed, int threads, double* inertia = nullptr);
int nearest_center(const float* x, const float* centers, int k, int d);

}  // namespace bp
