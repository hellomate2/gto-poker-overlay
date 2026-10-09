// ============================================================
// test_abs_v2.cpp: tests for abstraction v2 (`make test-v2`).
//
// Oracles: the published index sizes of Waugh's indexer
// (https://github.com/kdub0/hand-isomorphism), brute-force orbit counting
// with this codebase's own board isomorphism, closed-form 1-D earth mover's
// distance, brute-force opponent enumeration for OCHS, and the legacy
// abstraction tables (the v2 tables must reproduce them exactly).
// ============================================================
#include <algorithm>
#include <set>
#include <thread>

#include "abs_v2.h"
#include "abstraction.h"
#include "eval.h"
#include "hand_iso.h"

using namespace bp;

static int g_fail = 0, g_checks = 0;
#define CHECK(cond)                                                 \
  do {                                                              \
    g_checks++;                                                     \
    if (!(cond)) {                                                  \
      g_fail++;                                                     \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    }                                                               \
  } while (0)
#define CHECK_NEAR(a, b, tol) CHECK(std::fabs(double(a) - double(b)) <= (tol))

static const int THREADS = 4;

static void deal(Rng& rng, int* c, int n) {
  uint64_t used = 0;
  for (int j = 0; j < n; j++) {
    int x;
    do x = int(rng.below(52)); while (used >> x & 1);
    used |= 1ull << x;
    c[j] = x;
  }
}

// ---- Waugh indexer ------------------------------------------------------------------

static void test_index_sizes() {
  CHECK(hand_iso(0).size() == 169ull);
  CHECK(hand_iso(1).size() == 1286792ull);
  CHECK(hand_iso(2).size() == 13960050ull);
  CHECK(hand_iso(3).size() == 123156254ull);
}

static void test_preflop_partition() {
  // Waugh preflop index and preflop_class() must induce the same partition.
  std::vector<int> w2c(169, -1), c2w(169, -1);
  bool ok = true;
  for (int a = 0; a < 52; a++)
    for (int b = a + 1; b < 52; b++) {
      int h[2] = {a, b};
      int w = int(hand_iso(0).index(h, nullptr)), c = preflop_class(a, b);
      if (w2c[w] < 0) w2c[w] = c;
      if (c2w[c] < 0) c2w[c] = w;
      ok = ok && w2c[w] == c && c2w[c] == w;
    }
  CHECK(ok);
  CHECK(std::count(w2c.begin(), w2c.end(), -1) == 0);
}

// Orbits of (hole, board) under suit relabeling, counted with the legacy
// board canonicalization: for each canonical board, hole combos up to the
// board's stabilizer. Independent of Waugh's code.
static uint64_t brute_orbits(int k) {
  BoardIso iso;
  iso.build(k);
  std::atomic<uint64_t> total{0};
  std::vector<std::thread> pool;
  for (int t = 0; t < THREADS; t++)
    pool.emplace_back([&, t] {
      uint64_t cnt = 0;
      for (size_t bi = t; bi < iso.num_canon(); bi += THREADS) {
        int b[5];
        for (int j = 0; j < k; j++) b[j] = iso.canon_cards[bi][j];
        int stab[24], ns = 0;
        for (int p = 0; p < 24; p++) {
          int s[5];
          for (int j = 0; j < k; j++) s[j] = perm_card(b[j], p);
          std::sort(s, s + k);
          bool same = true;
          for (int j = 0; j < k; j++) same = same && s[j] == b[j];
          if (same) stab[ns++] = p;
        }
        uint64_t dead = 0;
        for (int j = 0; j < k; j++) dead |= 1ull << b[j];
        for (int h = 0; h < NUM_COMBOS; h++) {
          int x = combos().hi[h], y = combos().lo[h];
          if ((dead >> x & 1) || (dead >> y & 1)) continue;
          int rep = h;
          for (int q = 0; q < ns; q++) rep = std::min(rep, combo_index(perm_card(x, stab[q]), perm_card(y, stab[q])));
          cnt += rep == h;
        }
      }
      total += cnt;
    });
  for (auto& th : pool) th.join();
  return total.load();
}

static void test_orbit_counts_brute_force() {
  CHECK(brute_orbits(3) == 1286792ull);
  CHECK(brute_orbits(4) == 13960050ull);
  CHECK(brute_orbits(5) == 123156254ull);
}

static void test_flop_index_exhaustive() {
  // Every raw (hole, flop): the index must equal the index of the legacy
  // canonical form (suit invariance), and two legacy-canonical hands that are
  // in different orbits must get different indices (checked through the
  // orbit count above plus surjectivity here).
  BoardIso iso;
  iso.build(3);
  const HandIso& I = hand_iso(1);
  std::vector<uint8_t> hit(I.size(), 0);
  long long bad = 0, n = 0;
  int b[3];
  for (b[0] = 0; b[0] < 52; b[0]++)
    for (b[1] = b[0] + 1; b[1] < 52; b[1]++)
      for (b[2] = b[1] + 1; b[2] < 52; b[2]++) {
        int perm;
        uint32_t cid = iso.lookup(b, perm);
        int cb[3];
        for (int j = 0; j < 3; j++) cb[j] = iso.canon_cards[cid][j];
        for (int x = 0; x < 52; x++)
          for (int y = x + 1; y < 52; y++) {
            if (x == b[0] || x == b[1] || x == b[2] || y == b[0] || y == b[1] || y == b[2]) continue;
            int h[2] = {x, y}, ph[2] = {perm_card(x, perm), perm_card(y, perm)};
            int hr[2] = {y, x}, br[3] = {b[2], b[0], b[1]};  // order must not matter
            uint64_t i1 = I.index(h, b), i2 = I.index(ph, cb), i3 = I.index(hr, br);
            bad += (i1 != i2) + (i1 != i3);
            hit[i1] = 1;
            n++;
          }
      }
  CHECK(n == 25989600);
  CHECK(bad == 0);
  CHECK(std::count(hit.begin(), hit.end(), 0) == 0);
}

static void test_unindex_roundtrip() {
  const HandIso& F = hand_iso(1);
  long long bad = 0;
  for (uint64_t i = 0; i < F.size(); i++) {
    int h[2], b[3];
    F.unindex(i, h, b);
    bad += F.index(h, b) != i;
  }
  CHECK(bad == 0);
  for (int st = 2; st <= 3; st++) {
    const HandIso& I = hand_iso(st);
    Rng rng(st * 13);
    long long bad2 = 0;
    for (int s = 0; s < 1000000; s++) {
      uint64_t i = (rng.next() >> 11) % I.size();
      int h[2], b[5];
      I.unindex(i, h, b);
      bad2 += I.index(h, b) != i;
    }
    CHECK(bad2 == 0);
    // suit-relabeled and reordered hands share the index
    long long bad3 = 0;
    for (int s = 0; s < 1000000; s++) {
      int c[7];
      deal(rng, c, 2 + I.board_cards());
      int p = int(rng.below(24));
      int q[7];
      for (int j = 0; j < 2 + I.board_cards(); j++) q[j] = perm_card(c[j], p);
      std::swap(q[0], q[1]);
      std::reverse(q + 2, q + 2 + I.board_cards());
      bad3 += I.index(c, c + 2) != I.index(q, q + 2);
    }
    CHECK(bad3 == 0);
  }
}

static void test_class_sizes() {
  std::vector<uint32_t> w = waugh_class_sizes(1, THREADS);
  uint64_t tot = 0;
  uint32_t mn = ~0u, mx = 0;
  for (uint32_t x : w) tot += x, mn = std::min(mn, x), mx = std::max(mx, x);
  CHECK(tot == 25989600ull);  // C(52,2) * C(50,3)
  CHECK(mn >= 1);
  CHECK(mx <= 24 * 1);        // an orbit has at most 24 members
  std::vector<uint32_t> p = waugh_class_sizes(0, 1);
  uint64_t tp = 0;
  for (uint32_t x : p) tp += x;
  CHECK(tp == 1326);
}

// ---- EMD -----------------------------------------------------------------------------

static void test_emd() {
  Rng rng(3);
  // 1) exact solver vs the 1-D closed form (sum over gaps of |CDF diff| * gap)
  for (int rep = 0; rep < 200; rep++) {
    int K = 2 + int(rng.below(7));
    std::vector<double> pos(K);
    for (int i = 0; i < K; i++) pos[i] = (i ? pos[i - 1] : 0) + 0.1 + rng.uniform();
    std::vector<double> D(size_t(K) * K);
    for (int u = 0; u < K; u++)
      for (int v = 0; v < K; v++) D[size_t(u) * K + v] = std::fabs(pos[u] - pos[v]);
    int total = 1 + int(rng.below(47));
    std::vector<int> a(K, 0), b(K, 0);
    for (int t = 0; t < total; t++) a[rng.below(K)]++, b[rng.below(K)]++;
    double closed = 0, ca = 0, cb = 0;
    for (int i = 0; i + 1 < K; i++) {
      ca += a[i], cb += b[i];
      closed += std::fabs(ca - cb) / total * (pos[i + 1] - pos[i]);
    }
    CHECK_NEAR(emd_exact(a, b, D), closed, 1e-9);
  }
  // 2) greedy is a feasible transport: >= exact; equal when the point is one
  //    spike; zero against itself. Mean relative error printed for reference.
  double rel = 0;
  int nrel = 0;
  for (int rep = 0; rep < 300; rep++) {
    int K = 3 + int(rng.below(8));
    std::vector<float> P2(size_t(K) * 2);
    for (auto& x : P2) x = float(rng.uniform());
    std::vector<float> Df(size_t(K) * K);
    std::vector<double> Dd(size_t(K) * K);
    for (int u = 0; u < K; u++)
      for (int v = 0; v < K; v++) {
        double dx = P2[u * 2] - P2[v * 2], dy = P2[u * 2 + 1] - P2[v * 2 + 1];
        Dd[size_t(u) * K + v] = Df[size_t(u) * K + v] = float(std::sqrt(dx * dx + dy * dy));
      }
    for (int u = 0; u < K; u++)
      for (int v = 0; v < K; v++) Dd[size_t(u) * K + v] = Df[size_t(u) * K + v];
    Ground g;
    g.build(Df, K);
    const int total = 47;
    std::vector<int> a(K, 0), b(K, 0);
    bool spike = rep % 5 == 0;
    int su = int(rng.below(K));
    for (int t = 0; t < total; t++) a[spike ? su : rng.below(K)]++, b[rng.below(K)]++;
    std::vector<uint16_t> cl;
    std::vector<float> ms;
    std::vector<float> mean(K);
    for (int u = 0; u < K; u++) {
      if (a[u]) cl.push_back(uint16_t(u)), ms.push_back(float(a[u]) / total);
      mean[u] = float(b[u]) / total;
    }
    std::vector<float> scratch(K);
    double gr = emd_greedy(cl.data(), ms.data(), int(cl.size()), mean.data(), g, scratch.data());
    double ex = emd_exact(a, b, Dd);
    CHECK(gr >= ex - 1e-5);
    if (spike) CHECK_NEAR(gr, ex, 1e-5);
    std::vector<float> selfm(K);
    for (int u = 0; u < K; u++) selfm[u] = float(a[u]) / total;
    CHECK_NEAR(emd_greedy(cl.data(), ms.data(), int(cl.size()), selfm.data(), g, scratch.data()), 0.0, 1e-6);
    if (ex > 1e-9) rel += (gr - ex) / ex, nrel++;
  }
  std::printf("  greedy EMD vs exact on 300 random 2-D instances: mean relative excess %.4f\n", rel / nrel);
}

static void test_kmeans_emd_planted() {
  // Three planted groups on a 1-D line of 9 clusters; points are spikes near
  // positions 1, 4 and 7. k-means must separate them perfectly.
  const int K = 9;
  std::vector<float> D(K * K);
  for (int u = 0; u < K; u++)
    for (int v = 0; v < K; v++) D[u * K + v] = float(std::abs(u - v));
  Ground g;
  g.build(D, K);
  SparseHists P;
  P.K = K;
  P.off.push_back(0);
  Rng rng(9);
  std::vector<int> truth;
  for (int i = 0; i < 300; i++) {
    int grp = i % 3, ctr = 1 + 3 * grp;
    int u = ctr + int(rng.below(3)) - 1;
    P.clus.push_back(uint16_t(u));
    P.mass.push_back(0.5f);
    P.clus.push_back(uint16_t(ctr));
    P.mass.push_back(0.5f);
    if (u == ctr) {  // merge duplicate cluster entries
      P.clus.pop_back();
      P.mass.pop_back();
      P.mass.back() = 1.f;
    }
    P.off.push_back(P.clus.size());
    truth.push_back(grp);
  }
  std::vector<uint32_t> fit(300);
  for (int i = 0; i < 300; i++) fit[i] = uint32_t(i);
  double obj = 0;
  std::vector<float> C = kmeans_emd(P, fit, g, 3, 20, 5, 1, 2, &obj);
  std::vector<uint16_t> asg = assign_emd(P, C, 3, g, 2);
  std::set<std::pair<int, int>> pairs;
  for (int i = 0; i < 300; i++) pairs.insert({truth[i], asg[i]});
  CHECK(pairs.size() == 3);  // a bijection between planted groups and clusters
}

// ---- OCHS ------------------------------------------------------------------------------

static void test_ochs() {
  std::vector<int> occ = ochs_opponent_clusters(7, THREADS);
  CHECK(occ.size() == 169);
  std::vector<int> cnt(OCHS_DIM, 0);
  for (int c : occ) {
    CHECK(c >= 0 && c < OCHS_DIM);
    if (c >= 0 && c < OCHS_DIM) cnt[c]++;
  }
  for (int c = 0; c < OCHS_DIM; c++) CHECK(cnt[c] > 0);
  // clusters are ordered by mean equity: AA in the top cluster, 72o below it
  int AA = 12 * 13 + 12, s72o = 0 * 13 + 5;
  CHECK(occ[AA] == OCHS_DIM - 1);
  CHECK(occ[s72o] < occ[AA]);
  // the sweep matches brute force exactly, and the live-weighted average of
  // the 8 values reproduces river EHS
  Rng rng(21);
  double maxerr = 0;
  for (int rep = 0; rep < 40; rep++) {
    int b[5];
    deal(rng, b, 5);
    std::vector<float> o(size_t(NUM_COMBOS) * OCHS_DIM);
    river_ochs_all(b, occ.data(), o.data());
    float ehs[NUM_COMBOS];
    river_ehs_all(b, ehs);
    for (int s = 0; s < 6; s++) {
      int h[2];
      do {
        h[0] = int(rng.below(52));
        h[1] = int(rng.below(52));
      } while (h[0] == h[1] || std::find(b, b + 5, h[0]) != b + 5 || std::find(b, b + 5, h[1]) != b + 5);
      float br[OCHS_DIM];
      river_ochs_brute(b, h, occ.data(), br);
      const float* f = &o[size_t(combo_index(h[0], h[1])) * OCHS_DIM];
      for (int c = 0; c < OCHS_DIM; c++) maxerr = std::max(maxerr, double(std::fabs(f[c] - br[c])));
    }
    // invalid combos are flagged
    CHECK(o[size_t(combo_index(b[0], b[1])) * OCHS_DIM] < 0);
    (void)ehs;
  }
  CHECK(maxerr < 1e-5);
}

// ---- abstraction integration (small configuration) -------------------------------------

static AbsConfig small_cfg() {
  AbsConfig c;
  c.flop_k = 8;
  c.turn_k = 8;
  c.river_k = 8;
  c.bins = 10;
  c.sample_flops = 20;
  c.sample_turns = 20;
  c.sample_rivers = 60;
  c.kmeans_iters = 8;
  c.threads = THREADS;
  return c;
}

static void check_waugh_matches(const Abstraction& A, const char* what) {
  WaughTables W;
  waugh_from_legacy(A, W, THREADS, false);
  long long bad = 0;
  int b[3];
  for (b[0] = 0; b[0] < 52; b[0]++)
    for (b[1] = b[0] + 1; b[1] < 52; b[1]++)
      for (b[2] = b[1] + 1; b[2] < 52; b[2]++)
        for (int x = 0; x < 52; x++)
          for (int y = x + 1; y < 52; y++) {
            if (x == b[0] || x == b[1] || x == b[2] || y == b[0] || y == b[1] || y == b[2]) continue;
            int h[2] = {x, y};
            bad += A.flop(h, b) != W.flop_bucket(h, b);
          }
  Rng rng(5);
  long long bad_t = 0, bad_r = 0;
  for (int s = 0; s < 1000000; s++) {
    int c[7];
    deal(rng, c, 7);
    bad_t += A.turn(c, c + 2) != W.turn_bucket(c, c + 2);
    bad_r += A.river(c, c + 2) != W.river_bucket(c, c + 2);
  }
  std::printf("  %s: waugh vs legacy mismatches flop %lld (all), turn %lld, river %lld (1M sampled)\n", what, bad,
              bad_t, bad_r);
  CHECK(bad == 0);
  CHECK(bad_t == 0);
  CHECK(bad_r == 0);
}

static void check_suit_invariance(const Abstraction& A) {
  Rng rng(17);
  long long bad = 0;
  for (int s = 0; s < 300000; s++) {
    int c[7], q[7];
    deal(rng, c, 7);
    int p = int(rng.below(24));
    for (int j = 0; j < 7; j++) q[j] = perm_card(c[j], p);
    bad += A.flop(c, c + 2) != A.flop(q, q + 2);
    bad += A.turn(c, c + 2) != A.turn(q, q + 2);
    bad += A.river(c, c + 2) != A.river(q, q + 2);
  }
  CHECK(bad == 0);
}

static void test_integration() {
  std::string cache = "bin/test-cache";
  if (std::system(("mkdir -p " + cache).c_str()) != 0) die("mkdir");
  // legacy
  AbsConfig c0 = small_cfg();
  Abstraction L;
  L.load_or_build(c0, cache);
  check_waugh_matches(L, "legacy");
  // --waugh-lookup on the same config returns the same buckets
  AbsConfig cw = c0;
  cw.waugh_lookup = true;
  Abstraction LW;
  LW.load_or_build(cw, cache);
  CHECK(LW.waugh != nullptr && LW.waugh_river);
  {
    Rng rng(8);
    long long bad = 0;
    for (int s = 0; s < 500000; s++) {
      int c[7];
      deal(rng, c, 7);
      bad += L.flop(c, c + 2) != LW.flop(c, c + 2);
      bad += L.turn(c, c + 2) != LW.turn(c, c + 2);
      bad += L.river(c, c + 2) != LW.river(c, c + 2);
    }
    CHECK(bad == 0);
  }
  CHECK(c0.id() == "f8-t8-r8-b10-s7");  // default id unchanged
  // potential-aware flop
  AbsConfig cp = c0;
  cp.flop_mode = "pa";
  cp.pa_sample = 20000;
  cp.restarts = 2;
  CHECK(cp.id() != c0.id());
  Abstraction PA;
  PA.load_or_build(cp, cache);
  CHECK(PA.turn_bucket == L.turn_bucket);          // the turn is the legacy turn
  CHECK(PA.river_bounds == L.river_bounds);        // and the river too
  {
    std::vector<int> occ(cp.flop_k, 0);
    bool range_ok = true;
    for (size_t i = 0; i < PA.flop_bucket.size(); i++) {
      uint16_t v = PA.flop_bucket[i];
      if (v == 0xFFFF) continue;
      if (v >= cp.flop_k) range_ok = false;
      else occ[v]++;
    }
    CHECK(range_ok);
    for (int k = 0; k < cp.flop_k; k++) CHECK(occ[k] > 0);
    // valid entries are exactly the legacy table's valid entries
    // bucket labels are arbitrary, so compare partitions: the number of
    // distinct (legacy, pa) label pairs is k only if the partitions coincide
    long long diff_valid = 0;
    std::set<std::pair<int, int>> pairs;
    for (size_t i = 0; i < PA.flop_bucket.size(); i++) {
      diff_valid += (PA.flop_bucket[i] == 0xFFFF) != (L.flop_bucket[i] == 0xFFFF);
      if (PA.flop_bucket[i] != 0xFFFF) pairs.insert({L.flop_bucket[i], PA.flop_bucket[i]});
    }
    CHECK(diff_valid == 0);
    std::printf("  pa vs legacy flop partitions: %zu distinct (legacy, pa) bucket pairs (k = %d)\n", pairs.size(),
                cp.flop_k);
  }
  check_suit_invariance(PA);
  check_waugh_matches(PA, "pa");
  // reload from cache gives the same tables
  {
    Abstraction PA2;
    PA2.load_or_build(cp, cache);
    CHECK(PA2.flop_bucket == PA.flop_bucket);
  }
  // OCHS river
  AbsConfig co = c0;
  co.river_mode = "ochs";
  Abstraction OC;
  OC.load_or_build(co, cache);
  CHECK(OC.has_river_table());
  CHECK(OC.flop_bucket == L.flop_bucket);
  {
    std::vector<int> occ(co.river_k, 0);
    bool ok = true;
    for (uint8_t v : OC.river_bucket) {
      if (v == 0xFF) continue;
      if (v >= co.river_k) ok = false;
      else occ[v]++;
    }
    CHECK(ok);
    for (int k = 0; k < co.river_k; k++) CHECK(occ[k] > 0);
  }
  check_suit_invariance(OC);
  check_waugh_matches(OC, "ochs");
  {
    Abstraction OC2;  // loads the .river side file
    OC2.load_or_build(co, cache);
    CHECK(OC2.river_bucket == OC.river_bucket);
  }
}

int main(int argc, char** argv) {
  struct T {
    const char* name;
    void (*fn)();
  } tests[] = {
      {"index sizes", test_index_sizes},
      {"preflop partition", test_preflop_partition},
      {"orbit counts by brute force", test_orbit_counts_brute_force},
      {"flop index exhaustive", test_flop_index_exhaustive},
      {"unindex round trip", test_unindex_roundtrip},
      {"class sizes", test_class_sizes},
      {"emd", test_emd},
      {"kmeans emd planted", test_kmeans_emd_planted},
      {"ochs", test_ochs},
      {"integration", test_integration},
  };
  std::string only = argc > 1 ? argv[1] : "";
  for (auto& t : tests) {
    if (!only.empty() && only != t.name) continue;
    double t0 = now_sec();
    int f0 = g_fail;
    t.fn();
    std::printf("%-30s %s (%.1fs)\n", t.name, g_fail == f0 ? "ok" : "FAILED", now_sec() - t0);
    std::fflush(stdout);
  }
  std::printf("%d checks, %d failures\n", g_checks, g_fail);
  return g_fail ? 1 : 0;
}
