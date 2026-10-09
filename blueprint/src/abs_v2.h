// ============================================================
// abs_v2.h: card abstraction v2 (PLAN.md M2).
//
// 1. Waugh-indexed bucket tables. Every street's bucket table can be keyed by
//    the optimal hand index (hand_iso.h) instead of [canonical board][combo]:
//    1,286,792 / 13,960,050 / 123,156,254 entries on flop / turn / river
//    instead of 2,327,130 / 21,788,832 / 178,292,634. waugh_from_legacy()
//    projects an existing abstraction into these tables exactly (a hand's
//    features are suit-invariant, so every hand in an isomorphism class has
//    the same bucket); `bp absv2 check` verifies that on every (hole, flop)
//    and on sampled turn and river hands. `--waugh-lookup` makes the trainer
//    read buckets through these tables.
//
// 2. Potential-aware flop buckets (Ganzfried and Sandholm, AAAI 2014,
//    https://www.cs.cmu.edu/~sandholm/potential-aware_imperfect-recall.aaai14.pdf).
//    The turn is clustered first (the existing distribution-aware turn
//    buckets). Each flop hand becomes a histogram over the turn buckets it
//    reaches on the 47 possible turn cards, and flop hands are clustered with
//    k-means under the earth mover's distance whose ground distance is the
//    distance between turn cluster centers (1-D EMD between the centers'
//    river-equity distributions). The EMD is GS14's greedy approximation
//    (Algorithm 2) with the order fix noted in gpo-research/abstraction.md
//    section 4: the mean's remaining mass is decremented before the point's
//    target is cleared. emd_exact() is an exact transport solver used by the
//    tests to bound the approximation.
//    The clustering population is every Waugh flop index weighted by its
//    class size (the number of raw (hole, flop) hands it stands for). Centers
//    are fit on a weight-proportional sample with k-means++ seeding and
//    several restarts (lowest objective kept); then every index is assigned.
//
// 3. OCHS river buckets (Johanson et al., AAMAS 2013,
//    https://poker.cs.ualberta.ca/publications/AAMAS13-abstraction.pdf): a
//    river hand's feature is its win probability (ties half) against each of
//    8 opponent clusters of preflop hands, clustered with k-means under L2.
//    The 8 opponent clusters are our own reproduction of J13's method (EMD
//    k-means on the 169 preflop classes' final-equity histograms), not a copy
//    of J13's Table 1. See ochs_opponent_clusters().
// ============================================================
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "abstraction.h"

namespace bp {

class HandIso;

struct WaughTables {
  const HandIso* iso[4] = {nullptr, nullptr, nullptr, nullptr};
  std::vector<uint16_t> flop, turn;
  std::vector<uint8_t> river;  // empty when river_k > 255
  int flop_bucket(const int hole[2], const int* board) const;
  int turn_bucket(const int hole[2], const int* board) const;
  int river_bucket(const int hole[2], const int* board) const;
};

// Exact projection of a built/loaded abstraction (with its river table) into
// Waugh-indexed tables.
void waugh_from_legacy(const Abstraction& A, WaughTables& W, int threads, bool verbose = true);

// Number of raw hands in each Waugh class of a street (flop: 25,989,600 raw
// (hole, flop) hands in total). Exposed for tests.
std::vector<uint32_t> waugh_class_sizes(int street, int threads);

// ---- earth mover's distance ------------------------------------------------------
// Ground metric over K clusters: D[u*K + v], plus each row's clusters sorted by
// distance (order[u*K + i] = i-th closest cluster to u; order[u*K] = u).
struct Ground {
  int K = 0;
  std::vector<float> D;
  std::vector<uint16_t> order;
  void build(const std::vector<float>& dist, int k);
};
// GS14 Algorithm 2 (greedy transport). The point is sparse: nnz entries
// (cluster, mass); mean is dense over K. Both sum to 1. The result is the
// cost of a feasible transport, so it is >= the exact EMD.
float emd_greedy(const uint16_t* clus, const float* mass, int nnz, const float* mean, const Ground& g,
                 float* scratch /* K floats */);
// Exact EMD between two integer histograms with equal totals (successive
// shortest paths). For tests and for measuring the greedy error; O(total * K^3).
double emd_exact(const std::vector<int>& a, const std::vector<int>& b, const std::vector<double>& D);

// Sparse histograms over K next-street clusters, one per point.
struct SparseHists {
  int K = 0;
  std::vector<uint64_t> off;  // n + 1
  std::vector<uint16_t> clus;
  std::vector<float> mass;
  size_t n() const { return off.empty() ? 0 : off.size() - 1; }
};

// k-means under emd_greedy. Fits on the points listed in `fit` (duplicates
// allowed, unweighted), k-means++ seeding, `restarts` independent runs, keeps
// the lowest total distance. Returns k x K dense centers.
std::vector<float> kmeans_emd(const SparseHists& P, const std::vector<uint32_t>& fit, const Ground& g, int k,
                              int iters, int restarts, uint64_t seed, int threads, double* objective = nullptr,
                              bool verbose = false);
// Nearest center (under emd_greedy) for every point.
std::vector<uint16_t> assign_emd(const SparseHists& P, const std::vector<float>& centers, int k, const Ground& g,
                                 int threads);

// Potential-aware flop: fills A.flop_bucket (legacy layout) from the turn
// table already in A and the turn centers (turn_k x bins CDF rows).
void build_pa_flop(Abstraction& A, const std::vector<float>& turn_cdf_centers, bool verbose);

// ---- OCHS ------------------------------------------------------------------------
constexpr int OCHS_DIM = 8;
// Opponent cluster (0..7) of each of the 169 preflop classes, ordered by
// increasing mean equity. Deterministic for a given seed.
std::vector<int> ochs_opponent_clusters(uint64_t seed, int threads);
// OCHS vector of every hole combo on a 5-card board. out[combo * 8 + c] = P(win
// + tie/2) against a uniformly random opponent hand from cluster c (card
// removal exact); -1 in slot 0 for combos that intersect the board, and for a
// cluster with no live combos the value is 0.5.
void river_ochs_all(const int board[5], const int* opp_cluster_of_class, float* out);
// Brute-force reference for one hole (tests).
void river_ochs_brute(const int board[5], const int hole[2], const int* opp_cluster_of_class, float out[OCHS_DIM]);
// River OCHS buckets: fits centers on sampled boards, fills A.river_bucket
// (legacy layout) for every canonical river. Needs river_k <= 255.
void build_ochs_river(Abstraction& A, bool verbose);

}  // namespace bp
