// ============================================================
// abstraction.cpp: board isomorphism, EHS features, k-means, bucket tables.
// See abstraction.h for the scheme.
// ============================================================
#include "abstraction.h"

#include <algorithm>
#include <atomic>
#include <functional>
#include <thread>
#include <unordered_map>

#include "eval.h"

namespace bp {

const uint8_t SUIT_PERMS[24][4] = {
    {0, 1, 2, 3}, {0, 1, 3, 2}, {0, 2, 1, 3}, {0, 2, 3, 1}, {0, 3, 1, 2}, {0, 3, 2, 1},
    {1, 0, 2, 3}, {1, 0, 3, 2}, {1, 2, 0, 3}, {1, 2, 3, 0}, {1, 3, 0, 2}, {1, 3, 2, 0},
    {2, 0, 1, 3}, {2, 0, 3, 1}, {2, 1, 0, 3}, {2, 1, 3, 0}, {2, 3, 0, 1}, {2, 3, 1, 0},
    {3, 0, 1, 2}, {3, 0, 2, 1}, {3, 1, 0, 2}, {3, 1, 2, 0}, {3, 2, 0, 1}, {3, 2, 1, 0},
};

uint32_t colex_index(const int* s, int k) {
  uint32_t idx = 0;
  for (int i = 0; i < k; i++) idx += choose(s[i], i + 1);
  return idx;
}

// ---- board isomorphism -------------------------------------------------------

namespace {
// Sorted cards of a permuted board packed big-endian into a uint32 so integer
// comparison is lexicographic comparison of the sorted card lists.
uint64_t perm_key(const int* b, int k, int p, int* out_sorted) {
  int t[5];
  for (int i = 0; i < k; i++) t[i] = perm_card(b[i], p);
  std::sort(t, t + k);
  uint64_t key = 0;
  for (int i = 0; i < k; i++) {
    key = (key << 8) | uint64_t(t[i]);
    if (out_sorted) out_sorted[i] = t[i];
  }
  return key;
}
}  // namespace

void BoardIso::build(int kk) {
  k = kk;
  uint32_t n = choose(52, k);
  raw_to_canon.assign(n, 0);
  raw_perm.assign(n, 0);
  canon_cards.clear();
  canon_weight.clear();
  std::unordered_map<uint64_t, uint32_t> seen;
  int c[5];
  // enumerate sorted boards in colex order: last card is the outer loop
  std::function<void(int, int)> rec;  // (position, upper bound exclusive)
  std::vector<int> cur(k);
  rec = [&](int pos, int hi) {
    if (pos < 0) {
      for (int i = 0; i < k; i++) c[i] = cur[i];
      uint64_t best = ~0ull;
      int bp = 0;
      for (int p = 0; p < 24; p++) {
        uint64_t key = perm_key(c, k, p, nullptr);
        if (key < best) best = key, bp = p;
      }
      uint32_t raw = colex_index(c, k);
      auto it = seen.find(best);
      uint32_t id;
      if (it == seen.end()) {
        id = uint32_t(canon_cards.size());
        seen.emplace(best, id);
        std::array<uint8_t, 5> rep{};
        int srt[5];
        perm_key(c, k, bp, srt);
        for (int i = 0; i < k; i++) rep[i] = uint8_t(srt[i]);
        canon_cards.push_back(rep);
        canon_weight.push_back(0);
      } else {
        id = it->second;
      }
      raw_to_canon[raw] = id;
      raw_perm[raw] = uint8_t(bp);
      canon_weight[id]++;
      return;
    }
    for (int x = pos; x < hi; x++) {
      cur[pos] = x;
      rec(pos - 1, x);
    }
  };
  rec(k - 1, 52);
}

uint32_t BoardIso::lookup(const int* board, int& perm) const {
  int s[5];
  for (int i = 0; i < k; i++) s[i] = board[i];
  std::sort(s, s + k);
  uint32_t raw = colex_index(s, k);
  perm = raw_perm[raw];
  return raw_to_canon[raw];
}

// ---- EHS ---------------------------------------------------------------------

void river_ehs_all(const int board[5], float* out) {
  const EvalTables& T = eval_tables();
  uint64_t dead = 0;
  HandAcc B;
  for (int i = 0; i < 5; i++) {
    dead |= 1ull << board[i];
    B.add(board[i], T);
  }
  int rem[47], nr = 0;
  for (int c = 0; c < 52; c++)
    if (!(dead >> c & 1)) rem[nr++] = c;
  // 1,081 opponent/hero combos, keyed (strength << 11 | local index) so a
  // plain integer sort orders them by strength.
  uint32_t key[1081];
  uint8_t ca[1081], cb[1081];
  int n = 0;
  for (int i = 0; i < nr; i++) {
    HandAcc H = B;
    H.add(rem[i], T);
    for (int j = i + 1; j < nr; j++) {
      HandAcc G = H;
      G.add(rem[j], T);
      ca[n] = uint8_t(rem[i]);
      cb[n] = uint8_t(rem[j]);
      key[n] = (uint32_t(eval_acc(G, T)) << 11) | uint32_t(n);
      n++;
    }
  }
  std::sort(key, key + n);
  for (int i = 0; i < NUM_COMBOS; i++) out[i] = -1.f;
  // Sweep groups of equal strength. For hero h = (a, b):
  //   wins(h) = #lower combos disjoint from h
  //           = lower_total - lower_with[a] - lower_with[b]
  //   (no lower combo contains both a and b: that would be h itself).
  //   ties(h) = group_size - group_with[a] - group_with[b] + 1
  //   (inclusion-exclusion; the +1 restores h, which contains both and is
  //   subtracted twice, and that also removes h from its own tie count).
  int lower_total = 0;
  int lower_with[52] = {0}, group_with[52] = {0};
  const float denom = 1.f / 990.f;  // C(45, 2) opponent hands per hero
  int g0 = 0;
  while (g0 < n) {
    uint32_t s = key[g0] >> 11;
    int g1 = g0;
    while (g1 < n && (key[g1] >> 11) == s) g1++;
    for (int g = g0; g < g1; g++) {
      int i = int(key[g] & 2047);
      group_with[ca[i]]++;
      group_with[cb[i]]++;
    }
    int gs = g1 - g0;
    for (int g = g0; g < g1; g++) {
      int i = int(key[g] & 2047);
      int a = ca[i], b = cb[i];
      int wins = lower_total - lower_with[a] - lower_with[b];
      int ties = gs - group_with[a] - group_with[b] + 1;
      out[combo_index(a, b)] = (float(wins) + 0.5f * float(ties)) * denom;
    }
    for (int g = g0; g < g1; g++) {
      int i = int(key[g] & 2047);
      group_with[ca[i]]--;
      group_with[cb[i]]--;
      lower_with[ca[i]]++;
      lower_with[cb[i]]++;
    }
    lower_total += gs;
    g0 = g1;
  }
}

void river_ehs_pair(const int board[5], const int h0[2], const int h1[2], float out[2]) {
  const EvalTables& T = eval_tables();
  uint64_t dead = 0;
  HandAcc B;
  for (int i = 0; i < 5; i++) {
    dead |= 1ull << board[i];
    B.add(board[i], T);
  }
  uint64_t m0 = (1ull << h0[0]) | (1ull << h0[1]);
  uint64_t m1 = (1ull << h1[0]) | (1ull << h1[1]);
  HandAcc A0 = B, A1 = B;
  A0.add(h0[0], T); A0.add(h0[1], T);
  A1.add(h1[0], T); A1.add(h1[1], T);
  int v0 = eval_acc(A0, T), v1 = eval_acc(A1, T);
  int rem[47], nr = 0;
  for (int c = 0; c < 52; c++)
    if (!(dead >> c & 1)) rem[nr++] = c;
  // score*2 = 2*wins + ties, accumulated as integers
  int s0 = 0, s1 = 0;
  for (int i = 0; i < nr; i++) {
    HandAcc H = B;
    H.add(rem[i], T);
    uint64_t mi = 1ull << rem[i];
    for (int j = i + 1; j < nr; j++) {
      uint64_t m = mi | (1ull << rem[j]);
      HandAcc G = H;
      G.add(rem[j], T);
      int v = eval_acc(G, T);
      if (!(m & m0)) s0 += (v0 > v) * 2 + (v0 == v);
      if (!(m & m1)) s1 += (v1 > v) * 2 + (v1 == v);
    }
  }
  out[0] = float(s0) / (2.f * 990.f);
  out[1] = float(s1) / (2.f * 990.f);
}

// ---- k-means -----------------------------------------------------------------

int nearest_center(const float* x, const float* centers, int k, int d) {
  int best = 0;
  float bd = 3.4e38f;
  for (int c = 0; c < k; c++) {
    const float* m = centers + size_t(c) * d;
    float s = 0;
    for (int j = 0; j < d; j++) {
      float t = x[j] - m[j];
      s += t * t;
    }
    if (s < bd) bd = s, best = c;
  }
  return best;
}

namespace {
template <class F>
void parallel_for(size_t n, int threads, F f) {
  if (threads <= 1 || n < 2) {
    for (size_t i = 0; i < n; i++) f(i, 0);
    return;
  }
  std::atomic<size_t> next{0};
  std::vector<std::thread> pool;
  for (int t = 0; t < threads; t++)
    pool.emplace_back([&, t] {
      for (;;) {
        size_t i = next.fetch_add(1);
        if (i >= n) break;
        f(i, t);
      }
    });
  for (auto& th : pool) th.join();
}
}  // namespace

std::vector<float> kmeans(const std::vector<float>& X, const std::vector<float>* w, size_t n, int d,
                          int k, int iters, uint64_t seed, int threads, double* inertia) {
  Rng rng(seed);
  std::vector<float> C(size_t(k) * d);
  auto W = [&](size_t i) { return w ? (*w)[i] : 1.f; };
  // k-means++ seeding: first center by weight, then proportional to w * D^2.
  std::vector<float> dist(n, 3.4e38f);
  {
    double tot = 0;
    for (size_t i = 0; i < n; i++) tot += W(i);
    double r = rng.uniform() * tot;
    size_t pick = 0;
    for (size_t i = 0; i < n; i++) {
      r -= W(i);
      if (r <= 0) { pick = i; break; }
    }
    std::copy(&X[pick * d], &X[pick * d] + d, &C[0]);
  }
  for (int c = 1; c < k; c++) {
    const float* m = &C[size_t(c - 1) * d];
    double tot = 0;
    for (size_t i = 0; i < n; i++) {
      float s = 0;
      for (int j = 0; j < d; j++) {
        float t = X[i * d + j] - m[j];
        s += t * t;
      }
      dist[i] = std::min(dist[i], s);
      tot += double(dist[i]) * W(i);
    }
    size_t pick = rng.below(uint32_t(n));
    if (tot > 0) {
      double r = rng.uniform() * tot;
      for (size_t i = 0; i < n; i++) {
        r -= double(dist[i]) * W(i);
        if (r <= 0) { pick = i; break; }
      }
    }
    std::copy(&X[pick * d], &X[pick * d] + d, &C[size_t(c) * d]);
  }
  // Lloyd iterations; assignment is parallel, update is serial (cheap).
  std::vector<int> assign(n, -1);
  const size_t CH = 4096;
  for (int it = 0; it < iters; it++) {
    std::atomic<size_t> changed{0};
    parallel_for((n + CH - 1) / CH, threads, [&](size_t blk, int) {
      size_t lo = blk * CH, hi = std::min(n, lo + CH), ch = 0;
      for (size_t i = lo; i < hi; i++) {
        int a = nearest_center(&X[i * d], C.data(), k, d);
        if (a != assign[i]) ch++, assign[i] = a;
      }
      changed += ch;
    });
    std::vector<double> sum(size_t(k) * d, 0.0), cw(k, 0.0);
    for (size_t i = 0; i < n; i++) {
      double wi = W(i);
      int a = assign[i];
      cw[a] += wi;
      for (int j = 0; j < d; j++) sum[size_t(a) * d + j] += wi * X[i * d + j];
    }
    for (int c = 0; c < k; c++) {
      if (cw[c] > 0) {
        for (int j = 0; j < d; j++) C[size_t(c) * d + j] = float(sum[size_t(c) * d + j] / cw[c]);
      } else {
        // Empty cluster: re-seed on a random point so k stays meaningful.
        size_t pick = rng.below(uint32_t(n));
        std::copy(&X[pick * d], &X[pick * d] + d, &C[size_t(c) * d]);
      }
    }
    if (changed.load() == 0) break;
  }
  if (inertia) {
    double s = 0;
    for (size_t i = 0; i < n; i++) {
      int a = nearest_center(&X[i * d], C.data(), k, d);
      for (int j = 0; j < d; j++) {
        double t = X[i * d + j] - C[size_t(a) * d + j];
        s += W(i) * t * t;
      }
    }
    *inertia = s;
  }
  return C;
}

// ---- features ------------------------------------------------------------------

namespace {

// Histogram of river EHS for all 1,326 holes over every completion of a
// 3- or 4-card board. hist is 1326 x bins (counts). Invalid holes stay 0.
void board_histograms(const int* board, int k, int bins, std::vector<uint16_t>& hist) {
  hist.assign(size_t(NUM_COMBOS) * bins, 0);
  uint64_t dead = 0;
  for (int i = 0; i < k; i++) dead |= 1ull << board[i];
  int rem[49], nr = 0;
  for (int c = 0; c < 52; c++)
    if (!(dead >> c & 1)) rem[nr++] = c;
  int b5[5];
  for (int i = 0; i < k; i++) b5[i] = board[i];
  float ehs[NUM_COMBOS];
  auto accumulate = [&] {
    river_ehs_all(b5, ehs);
    for (int h = 0; h < NUM_COMBOS; h++) {
      float e = ehs[h];
      if (e < 0) continue;
      int bin = std::min(bins - 1, int(e * bins));
      hist[size_t(h) * bins + bin]++;
    }
  };
  if (k == 4) {
    for (int i = 0; i < nr; i++) {
      b5[4] = rem[i];
      accumulate();
    }
  } else {
    for (int i = 0; i < nr; i++)
      for (int j = i + 1; j < nr; j++) {
        b5[3] = rem[i];
        b5[4] = rem[j];
        accumulate();
      }
  }
}

// Histogram row -> normalized CDF feature. Returns false for an empty row.
bool hist_to_cdf(const uint16_t* h, int bins, float* out) {
  uint32_t tot = 0;
  for (int b = 0; b < bins; b++) tot += h[b];
  if (!tot) return false;
  uint32_t acc = 0;
  for (int b = 0; b < bins; b++) {
    acc += h[b];
    out[b] = float(acc) / float(tot);
  }
  return true;
}

// Fit centers on sampled boards, then bucket every canonical board.
void build_street(const BoardIso& iso, int k_board, int K, const AbsConfig& cfg, int nsample,
                  std::vector<uint16_t>& table, bool verbose, const char* name) {
  const int bins = cfg.bins;
  Rng rng(cfg.seed * 1000003ULL + uint64_t(k_board));
  // 1) sample raw boards uniformly (so canonical boards appear in proportion
  //    to their orbit size) and collect every hole's CDF feature.
  std::vector<int> picks;
  for (int s = 0; s < nsample; s++) {
    int b[4];
    uint64_t used = 0;
    for (int i = 0; i < k_board; i++) {
      int c;
      do c = int(rng.below(52)); while (used >> c & 1);
      used |= 1ull << c;
      b[i] = c;
    }
    int perm;
    picks.push_back(int(iso.lookup(b, perm)));
  }
  double t0 = now_sec();
  std::vector<std::vector<float>> feats(picks.size());
  parallel_for(picks.size(), cfg.threads, [&](size_t i, int) {
    std::vector<uint16_t> hist;
    int b[4];
    for (int j = 0; j < k_board; j++) b[j] = iso.canon_cards[picks[i]][j];
    board_histograms(b, k_board, bins, hist);
    std::vector<float> f;
    float row[256];
    for (int h = 0; h < NUM_COMBOS; h++)
      if (hist_to_cdf(&hist[size_t(h) * bins], bins, row)) f.insert(f.end(), row, row + bins);
    feats[i] = std::move(f);
  });
  std::vector<float> X;
  for (auto& f : feats) X.insert(X.end(), f.begin(), f.end());
  size_t n = X.size() / bins;
  double inertia = 0;
  std::vector<float> C = kmeans(X, nullptr, n, bins, K, cfg.kmeans_iters, cfg.seed + k_board,
                                cfg.threads, &inertia);
  if (verbose)
    std::printf("  %s: k-means on %zu points (%d boards) in %.1fs, mean sq dist %.5f\n", name, n,
                nsample, now_sec() - t0, inertia / double(n));
  X.clear();
  X.shrink_to_fit();
  // 2) bucket every canonical board.
  t0 = now_sec();
  size_t nb = iso.num_canon();
  table.assign(nb * NUM_COMBOS, 0xFFFF);
  std::atomic<size_t> done{0};
  parallel_for(nb, cfg.threads, [&](size_t i, int) {
    std::vector<uint16_t> hist;
    int b[4];
    for (int j = 0; j < k_board; j++) b[j] = iso.canon_cards[i][j];
    board_histograms(b, k_board, bins, hist);
    float row[256];
    for (int h = 0; h < NUM_COMBOS; h++)
      if (hist_to_cdf(&hist[size_t(h) * bins], bins, row))
        table[i * NUM_COMBOS + h] = uint16_t(nearest_center(row, C.data(), K, bins));
    size_t dn = ++done;
    if (verbose && dn % 2000 == 0)
      std::printf("  %s: %zu/%zu boards (%.0fs)\n", name, dn, nb, now_sec() - t0), std::fflush(stdout);
  });
  if (verbose) std::printf("  %s: bucketed %zu canonical boards in %.1fs\n", name, nb, now_sec() - t0);
}

}  // namespace

std::string AbsConfig::id() const {
  char buf[128];
  std::snprintf(buf, sizeof buf, "f%d-t%d-r%d-b%d-s%llu", flop_k, turn_k, river_k, bins,
                (unsigned long long)seed);
  return buf;
}

void Abstraction::build(const AbsConfig& c, bool verbose) {
  cfg = c;
  if (cfg.bins > 256) die("bins must be <= 256");
  if (flop_iso.k != 3) flop_iso.build(3);
  if (turn_iso.k != 4) turn_iso.build(4);
  double t0 = now_sec();
  if (verbose) std::printf("building abstraction %s (%d threads)\n", cfg.id().c_str(), cfg.threads);
  build_street(flop_iso, 3, cfg.flop_k, cfg, cfg.sample_flops, flop_bucket, verbose, "flop");
  build_street(turn_iso, 4, cfg.turn_k, cfg, cfg.sample_turns, turn_bucket, verbose, "turn");
  // river: 1-D k-means on EHS of sampled boards
  Rng rng(cfg.seed * 7919ULL + 5);
  std::vector<float> X;
  std::vector<std::vector<float>> per(cfg.sample_rivers);
  std::vector<uint64_t> seeds(cfg.sample_rivers);
  for (auto& s : seeds) s = rng.next();
  parallel_for(per.size(), cfg.threads, [&](size_t i, int) {
    Rng r(seeds[i]);
    int b[5];
    uint64_t used = 0;
    for (int j = 0; j < 5; j++) {
      int cc;
      do cc = int(r.below(52)); while (used >> cc & 1);
      used |= 1ull << cc;
      b[j] = cc;
    }
    float e[NUM_COMBOS];
    river_ehs_all(b, e);
    for (int h = 0; h < NUM_COMBOS; h++)
      if (e[h] >= 0) per[i].push_back(e[h]);
  });
  for (auto& v : per) X.insert(X.end(), v.begin(), v.end());
  std::vector<float> C = kmeans(X, nullptr, X.size(), 1, cfg.river_k, cfg.kmeans_iters * 2,
                                cfg.seed + 5, cfg.threads);
  std::sort(C.begin(), C.end());
  river_centers = C;
  river_bounds.clear();
  for (size_t i = 0; i + 1 < C.size(); i++) river_bounds.push_back(0.5f * (C[i] + C[i + 1]));
  if (verbose)
    std::printf("  river: 1-D k-means on %zu EHS samples; total build %.1fs\n", X.size(),
                now_sec() - t0);
}

int Abstraction::flop(const int hole[2], const int board[3]) const {
  int perm;
  uint32_t id = flop_iso.lookup(board, perm);
  return flop_bucket[size_t(id) * NUM_COMBOS + combo_index(perm_card(hole[0], perm), perm_card(hole[1], perm))];
}

int Abstraction::turn(const int hole[2], const int board[4]) const {
  int perm;
  uint32_t id = turn_iso.lookup(board, perm);
  return turn_bucket[size_t(id) * NUM_COMBOS + combo_index(perm_card(hole[0], perm), perm_card(hole[1], perm))];
}

int Abstraction::river_from_ehs(float e) const {
  return int(std::upper_bound(river_bounds.begin(), river_bounds.end(), e) - river_bounds.begin());
}

int Abstraction::river(const int hole[2], const int board[5]) const {
  int perm;
  uint32_t id = river_iso.lookup(board, perm);
  return river_bucket[size_t(id) * NUM_COMBOS + combo_index(perm_card(hole[0], perm), perm_card(hole[1], perm))];
}

void Abstraction::prepare_river_table(int threads, bool verbose) {
  if (cfg.river_k > 255) return;  // stay on the on-the-fly EHS path
  double t0 = now_sec();
  if (river_iso.k != 5) river_iso.build(5);
  double t1 = now_sec();
  size_t nb = river_iso.num_canon();
  river_bucket.assign(nb * NUM_COMBOS, 0xFF);
  parallel_for(nb, threads, [&](size_t i, int) {
    int b[5];
    for (int j = 0; j < 5; j++) b[j] = river_iso.canon_cards[i][j];
    float e[NUM_COMBOS];
    river_ehs_all(b, e);
    for (int h = 0; h < NUM_COMBOS; h++)
      if (e[h] >= 0) river_bucket[i * NUM_COMBOS + h] = uint8_t(river_from_ehs(e[h]));
  });
  if (verbose)
    std::printf("river table: %zu canonical rivers (iso %.1fs, EHS %.1fs, %.0f MB)\n", nb, t1 - t0,
                now_sec() - t1, river_bucket.size() / 1e6);
}

// ---- persistence ------------------------------------------------------------------
// File: "GPOABS01", AbsConfig fields, then flop table, turn table, river
// centers. Canonical-board maps are rebuilt on load (deterministic, < 1 s).

namespace {
const char ABS_MAGIC[8] = {'G', 'P', 'O', 'A', 'B', 'S', '0', '1'};
}

std::string Abstraction::path_in(const std::string& dir) const { return dir + "/abs-" + cfg.id() + ".bin"; }

bool Abstraction::save(const std::string& path) const {
  std::string tmp = path + ".tmp";
  FILE* f = std::fopen(tmp.c_str(), "wb");
  if (!f) return false;
  int32_t hdr[5] = {cfg.flop_k, cfg.turn_k, cfg.river_k, cfg.bins, 0};
  uint64_t n1 = flop_bucket.size(), n2 = turn_bucket.size(), n3 = river_centers.size();
  std::fwrite(ABS_MAGIC, 1, 8, f);
  std::fwrite(hdr, sizeof hdr, 1, f);
  std::fwrite(&cfg.seed, 8, 1, f);
  std::fwrite(&n1, 8, 1, f);
  std::fwrite(&n2, 8, 1, f);
  std::fwrite(&n3, 8, 1, f);
  std::fwrite(flop_bucket.data(), 2, n1, f);
  std::fwrite(turn_bucket.data(), 2, n2, f);
  std::fwrite(river_centers.data(), 4, n3, f);
  bool ok = std::fclose(f) == 0;
  return ok && std::rename(tmp.c_str(), path.c_str()) == 0;
}

bool Abstraction::load(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  char magic[8];
  int32_t hdr[5];
  uint64_t seed, n1, n2, n3;
  bool ok = std::fread(magic, 1, 8, f) == 8 && std::memcmp(magic, ABS_MAGIC, 8) == 0 &&
            std::fread(hdr, sizeof hdr, 1, f) == 1 && std::fread(&seed, 8, 1, f) == 1 &&
            std::fread(&n1, 8, 1, f) == 1 && std::fread(&n2, 8, 1, f) == 1 && std::fread(&n3, 8, 1, f) == 1;
  if (ok) {
    cfg.flop_k = hdr[0]; cfg.turn_k = hdr[1]; cfg.river_k = hdr[2]; cfg.bins = hdr[3]; cfg.seed = seed;
    flop_bucket.resize(n1);
    turn_bucket.resize(n2);
    river_centers.resize(n3);
    ok = std::fread(flop_bucket.data(), 2, n1, f) == n1 && std::fread(turn_bucket.data(), 2, n2, f) == n2 &&
         std::fread(river_centers.data(), 4, n3, f) == n3;
  }
  std::fclose(f);
  if (!ok) return false;
  if (flop_iso.k != 3) flop_iso.build(3);
  if (turn_iso.k != 4) turn_iso.build(4);
  river_bounds.clear();
  for (size_t i = 0; i + 1 < river_centers.size(); i++)
    river_bounds.push_back(0.5f * (river_centers[i] + river_centers[i + 1]));
  return flop_bucket.size() == flop_iso.num_canon() * NUM_COMBOS &&
         turn_bucket.size() == turn_iso.num_canon() * NUM_COMBOS;
}

void Abstraction::load_or_build(const AbsConfig& c, const std::string& dir) {
  cfg = c;
  std::string p = path_in(dir);
  if (load(p)) {
    std::printf("loaded abstraction %s\n", p.c_str());
  } else {
    build(c, true);
    std::string cmd = "mkdir -p '" + dir + "'";
    if (std::system(cmd.c_str()) != 0) die("cannot create " + dir);
    if (!save(p)) die("cannot write " + p);
    std::printf("saved abstraction %s\n", p.c_str());
  }
  prepare_river_table(c.threads);
}

}  // namespace bp
