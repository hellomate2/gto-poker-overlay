// ============================================================
// abs_v2.cpp: Waugh-indexed tables, potential-aware flop, OCHS river.
// See abs_v2.h.
// ============================================================
#include "abs_v2.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <thread>

#include "eval.h"
#include "hand_iso.h"

namespace bp {

namespace {

template <class F>
void pfor(size_t n, int threads, F f) {
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

// Chunked parallel loop over [0, n): f(lo, hi, thread).
template <class F>
void pfor_chunks(size_t n, size_t chunk, int threads, F f) {
  size_t nb = (n + chunk - 1) / chunk;
  pfor(nb, threads, [&](size_t b, int t) { f(b * chunk, std::min(n, (b + 1) * chunk), t); });
}

}  // namespace

// ---- Waugh tables ------------------------------------------------------------------

int WaughTables::flop_bucket(const int hole[2], const int* board) const {
  return flop[iso[1]->index(hole, board)];
}
int WaughTables::turn_bucket(const int hole[2], const int* board) const {
  return turn[iso[2]->index(hole, board)];
}
int WaughTables::river_bucket(const int hole[2], const int* board) const {
  return river[iso[3]->index(hole, board)];
}

void waugh_from_legacy(const Abstraction& A, WaughTables& W, int threads, bool verbose) {
  double t0 = now_sec();
  for (int s = 1; s < 4; s++) W.iso[s] = &hand_iso(s);
  W.flop.assign(W.iso[1]->size(), 0xFFFF);
  W.turn.assign(W.iso[2]->size(), 0xFFFF);
  pfor_chunks(W.flop.size(), 1 << 14, threads, [&](size_t lo, size_t hi, int) {
    int h[2], b[3];
    for (size_t i = lo; i < hi; i++) {
      W.iso[1]->unindex(i, h, b);
      W.flop[i] = uint16_t(A.flop(h, b));
    }
  });
  pfor_chunks(W.turn.size(), 1 << 14, threads, [&](size_t lo, size_t hi, int) {
    int h[2], b[4];
    for (size_t i = lo; i < hi; i++) {
      W.iso[2]->unindex(i, h, b);
      W.turn[i] = uint16_t(A.turn(h, b));
    }
  });
  if (A.has_river_table()) {
    W.river.assign(W.iso[3]->size(), 0xFF);
    pfor_chunks(W.river.size(), 1 << 16, threads, [&](size_t lo, size_t hi, int) {
      int h[2], b[5];
      for (size_t i = lo; i < hi; i++) {
        W.iso[3]->unindex(i, h, b);
        W.river[i] = uint8_t(A.river(h, b));
      }
    });
  }
  if (verbose)
    std::printf("waugh tables: flop %zu, turn %zu, river %zu entries (%.0f MB) in %.1fs\n", W.flop.size(),
                W.turn.size(), W.river.size(),
                (W.flop.size() * 2 + W.turn.size() * 2 + W.river.size()) / 1e6, now_sec() - t0);
}

std::vector<uint32_t> waugh_class_sizes(int street, int threads) {
  const HandIso& I = hand_iso(street);
  std::vector<uint32_t> cnt(I.size(), 0);
  const int nb = I.board_cards();
  if (street == 0) {
    for (int a = 0; a < 52; a++)
      for (int b = a + 1; b < 52; b++) {
        int h[2] = {a, b};
        cnt[I.index(h, nullptr)]++;
      }
    return cnt;
  }
  // enumerate boards in colex order, all disjoint holes for each
  uint32_t nboards = choose(52, nb);
  pfor_chunks(nboards, 64, threads, [&](size_t lo, size_t hi, int) {
    for (size_t r = lo; r < hi; r++) {
      // unrank colex r into nb cards
      int b[5];
      uint32_t x = uint32_t(r);
      for (int k = nb; k >= 1; k--) {
        int c = k - 1;
        while (choose(c + 1, k) <= x) c++;
        b[k - 1] = c;
        x -= choose(c, k);
      }
      uint64_t dead = 0;
      for (int i = 0; i < nb; i++) dead |= 1ull << b[i];
      for (int a = 0; a < 52; a++) {
        if (dead >> a & 1) continue;
        for (int c = a + 1; c < 52; c++) {
          if (dead >> c & 1) continue;
          int h[2] = {a, c};
          __atomic_fetch_add(&cnt[I.index(h, b)], 1u, __ATOMIC_RELAXED);
        }
      }
    }
  });
  return cnt;
}

// ---- EMD -------------------------------------------------------------------------------

void Ground::build(const std::vector<float>& dist, int k) {
  K = k;
  D = dist;
  order.assign(size_t(k) * k, 0);
  std::vector<uint16_t> idx(k);
  for (int u = 0; u < k; u++) {
    for (int v = 0; v < k; v++) idx[v] = uint16_t(v);
    const float* row = &D[size_t(u) * k];
    std::stable_sort(idx.begin(), idx.end(), [&](uint16_t a, uint16_t b) {
      if (row[a] != row[b]) return row[a] < row[b];
      return (a == u) > (b == u);  // u itself first among ties
    });
    std::copy(idx.begin(), idx.end(), &order[size_t(u) * k]);
  }
}

float emd_greedy(const uint16_t* clus, const float* mass, int nnz, const float* mean, const Ground& g,
                 float* rem) {
  const int K = g.K;
  for (int v = 0; v < K; v++) rem[v] = mean[v];
  float tgt[64];
  int left = 0;
  for (int j = 0; j < nnz; j++) {
    tgt[j] = mass[j];
    if (tgt[j] > 0) left++;
  }
  float cost = 0;
  for (int i = 0; i < K && left > 0; i++) {
    for (int j = 0; j < nnz; j++) {
      if (tgt[j] <= 0) continue;
      const int u = clus[j];
      const int v = g.order[size_t(u) * K + i];
      const float r = rem[v];
      if (r <= 0) continue;
      const float d = g.D[size_t(u) * K + v];
      if (r < tgt[j]) {
        // take everything the mean has left at v
        cost += r * d;
        tgt[j] -= r;
        rem[v] = 0;
      } else {
        // the point's remaining mass fits: consume it from the mean first,
        // then clear the target (GS14 pseudocode clears first: the bug)
        cost += tgt[j] * d;
        rem[v] = r - tgt[j];
        tgt[j] = 0;
        left--;
      }
    }
  }
  return cost;
}

double emd_exact(const std::vector<int>& a, const std::vector<int>& b, const std::vector<double>& D) {
  // Min-cost flow on the complete bipartite graph supply a -> demand b with
  // costs D, infinite capacities, via successive shortest paths
  // (Bellman-Ford on the residual graph). Unit = one count; the result is
  // normalized by the total so it compares with emd_greedy on masses.
  const int K = int(a.size());
  int total = 0, tb = 0;
  for (int x : a) total += x;
  for (int x : b) tb += x;
  if (total != tb) die("emd_exact: totals differ");
  if (total == 0) return 0;
  // nodes: 0 source, 1..K supply, K+1..2K demand, 2K+1 sink
  const int N = 2 * K + 2, S = 0, T = 2 * K + 1;
  struct E { int to, rev; int cap; double cost; };
  std::vector<std::vector<E>> G(N);
  auto add = [&](int u, int v, int cap, double c) {
    G[u].push_back({v, int(G[v].size()), cap, c});
    G[v].push_back({u, int(G[u].size()) - 1, 0, -c});
  };
  for (int u = 0; u < K; u++) add(S, 1 + u, a[u], 0);
  for (int v = 0; v < K; v++) add(K + 1 + v, T, b[v], 0);
  for (int u = 0; u < K; u++)
    for (int v = 0; v < K; v++) add(1 + u, K + 1 + v, total, D[size_t(u) * K + v]);
  double cost = 0;
  int flow = 0;
  while (flow < total) {
    std::vector<double> dist(N, 1e300);
    std::vector<int> pv(N, -1), pe(N, -1);
    dist[S] = 0;
    for (int it = 0; it < N; it++) {
      bool upd = false;
      for (int u = 0; u < N; u++) {
        if (dist[u] >= 1e299) continue;
        for (int e = 0; e < int(G[u].size()); e++) {
          const E& ed = G[u][e];
          if (ed.cap > 0 && dist[u] + ed.cost < dist[ed.to] - 1e-12) {
            dist[ed.to] = dist[u] + ed.cost;
            pv[ed.to] = u;
            pe[ed.to] = e;
            upd = true;
          }
        }
      }
      if (!upd) break;
    }
    if (dist[T] >= 1e299) die("emd_exact: no augmenting path");
    int f = total - flow;
    for (int v = T; v != S; v = pv[v]) f = std::min(f, G[pv[v]][pe[v]].cap);
    for (int v = T; v != S; v = pv[v]) {
      E& ed = G[pv[v]][pe[v]];
      ed.cap -= f;
      G[v][ed.rev].cap += f;
    }
    flow += f;
    cost += double(f) * dist[T];
  }
  return cost / double(total);
}

// ---- k-means under EMD ------------------------------------------------------------------

namespace {

double point_center_dist(const SparseHists& P, size_t i, const float* c, const Ground& g, float* scratch) {
  uint64_t o = P.off[i];
  return emd_greedy(&P.clus[o], &P.mass[o], int(P.off[i + 1] - o), c, g, scratch);
}

void point_to_dense(const SparseHists& P, size_t i, float* out) {
  std::fill(out, out + P.K, 0.f);
  for (uint64_t o = P.off[i]; o < P.off[i + 1]; o++) out[P.clus[o]] += P.mass[o];
}

}  // namespace

std::vector<uint16_t> assign_emd(const SparseHists& P, const std::vector<float>& C, int k, const Ground& g,
                                 int threads) {
  std::vector<uint16_t> out(P.n());
  pfor_chunks(P.n(), 4096, threads, [&](size_t lo, size_t hi, int) {
    std::vector<float> scratch(g.K);
    for (size_t i = lo; i < hi; i++) {
      int best = 0;
      double bd = 1e30;
      for (int c = 0; c < k; c++) {
        double d = point_center_dist(P, i, &C[size_t(c) * g.K], g, scratch.data());
        if (d < bd) bd = d, best = c;
      }
      out[i] = uint16_t(best);
    }
  });
  return out;
}

std::vector<float> kmeans_emd(const SparseHists& P, const std::vector<uint32_t>& fit, const Ground& g, int k,
                              int iters, int restarts, uint64_t seed, int threads, double* objective,
                              bool verbose) {
  const int K = g.K;
  const size_t n = fit.size();
  std::vector<float> best_C;
  double best_obj = 1e300;
  for (int rs = 0; rs < std::max(1, restarts); rs++) {
    Rng rng(seed * 0x9E3779B97F4A7C15ULL + uint64_t(rs) * 7919 + 1);
    std::vector<float> C(size_t(k) * K, 0.f);
    // k-means++ seeding with D^2 weighting under EMD
    std::vector<double> dmin(n, 1e30);
    point_to_dense(P, fit[rng.below(uint32_t(n))], &C[0]);
    for (int c = 1; c <= k; c++) {
      const float* m = &C[size_t(c - 1) * K];
      pfor_chunks(n, 4096, threads, [&](size_t lo, size_t hi, int) {
        std::vector<float> scratch(K);
        for (size_t i = lo; i < hi; i++) {
          double d = point_center_dist(P, fit[i], m, g, scratch.data());
          if (d < dmin[i]) dmin[i] = d;
        }
      });
      if (c == k) break;
      double tot = 0;
      for (size_t i = 0; i < n; i++) tot += dmin[i] * dmin[i];
      size_t pick = rng.below(uint32_t(n));
      if (tot > 0) {
        double r = rng.uniform() * tot;
        for (size_t i = 0; i < n; i++) {
          r -= dmin[i] * dmin[i];
          if (r <= 0) { pick = i; break; }
        }
      }
      point_to_dense(P, fit[pick], &C[size_t(c) * K]);
    }
    // Lloyd iterations
    std::vector<int> asg(n, -1);
    std::vector<double> dist(n, 0);
    double obj = 0;
    for (int it = 0; it < iters; it++) {
      std::atomic<size_t> changed{0};
      pfor_chunks(n, 2048, threads, [&](size_t lo, size_t hi, int) {
        std::vector<float> scratch(K);
        size_t ch = 0;
        for (size_t i = lo; i < hi; i++) {
          int best = 0;
          double bd = 1e30;
          for (int c = 0; c < k; c++) {
            double d = point_center_dist(P, fit[i], &C[size_t(c) * K], g, scratch.data());
            if (d < bd) bd = d, best = c;
          }
          if (best != asg[i]) ch++, asg[i] = best;
          dist[i] = bd;
        }
        changed += ch;
      });
      obj = 0;
      for (size_t i = 0; i < n; i++) obj += dist[i];
      if (verbose)
        std::printf("    restart %d iter %2d: mean EMD %.5f, %zu reassigned\n", rs, it, obj / double(n),
                    changed.load()),
            std::fflush(stdout);
      if (changed.load() == 0) break;
      std::vector<double> sum(size_t(k) * K, 0.0), cw(k, 0.0);
      for (size_t i = 0; i < n; i++) {
        int a = asg[i];
        cw[a] += 1;
        size_t p = fit[i];
        for (uint64_t o = P.off[p]; o < P.off[p + 1]; o++) sum[size_t(a) * K + P.clus[o]] += P.mass[o];
      }
      for (int c = 0; c < k; c++) {
        if (cw[c] > 0) {
          for (int j = 0; j < K; j++) C[size_t(c) * K + j] = float(sum[size_t(c) * K + j] / cw[c]);
        } else {
          // empty cluster: re-seed on the point farthest from its center
          size_t far = size_t(std::max_element(dist.begin(), dist.end()) - dist.begin());
          point_to_dense(P, fit[far], &C[size_t(c) * K]);
          dist[far] = 0;
        }
      }
    }
    if (verbose) std::printf("    restart %d: objective (mean EMD) %.6f\n", rs, obj / double(n));
    if (obj < best_obj) best_obj = obj, best_C = C;
  }
  if (objective) *objective = best_obj;
  return best_C;
}

// ---- potential-aware flop --------------------------------------------------------------

void build_pa_flop(Abstraction& A, const std::vector<float>& TC, bool verbose) {
  const AbsConfig& cfg = A.cfg;
  const int KT = cfg.turn_k, bins = cfg.bins, K = cfg.flop_k;
  const int threads = cfg.threads;
  double t0 = now_sec();
  if (TC.size() != size_t(KT) * bins) die("build_pa_flop: turn centers missing");
  // ground distance: 1-D EMD between the turn centers' river-equity
  // distributions = bin width * L1 between their CDFs
  std::vector<float> D(size_t(KT) * KT);
  for (int u = 0; u < KT; u++)
    for (int v = 0; v < KT; v++) {
      double s = 0;
      for (int b = 0; b < bins; b++) s += std::fabs(double(TC[size_t(u) * bins + b]) - TC[size_t(v) * bins + b]);
      D[size_t(u) * KT + v] = float(s / bins);
    }
  Ground g;
  g.build(D, KT);
  // points: every Waugh flop index -> histogram over turn buckets
  const HandIso& I = hand_iso(1);
  const size_t n = I.size();
  SparseHists P;
  P.K = KT;
  std::vector<uint8_t> nnz(n);
  // pass 1: nnz per point
  auto turn_hist = [&](size_t i, uint8_t* cnt) {
    int h[2], b[4];
    I.unindex(i, h, b);
    uint64_t dead = (1ull << h[0]) | (1ull << h[1]) | (1ull << b[0]) | (1ull << b[1]) | (1ull << b[2]);
    std::fill(cnt, cnt + KT, 0);
    for (int t = 0; t < 52; t++) {
      if (dead >> t & 1) continue;
      b[3] = t;
      cnt[A.turn(h, b)]++;
    }
  };
  pfor_chunks(n, 4096, threads, [&](size_t lo, size_t hi, int) {
    std::vector<uint8_t> cnt(KT);
    for (size_t i = lo; i < hi; i++) {
      turn_hist(i, cnt.data());
      int z = 0;
      for (int c = 0; c < KT; c++) z += cnt[c] > 0;
      nnz[i] = uint8_t(z);
    }
  });
  P.off.assign(n + 1, 0);
  for (size_t i = 0; i < n; i++) P.off[i + 1] = P.off[i] + nnz[i];
  P.clus.resize(P.off[n]);
  P.mass.resize(P.off[n]);
  pfor_chunks(n, 4096, threads, [&](size_t lo, size_t hi, int) {
    std::vector<uint8_t> cnt(KT);
    for (size_t i = lo; i < hi; i++) {
      turn_hist(i, cnt.data());
      uint64_t o = P.off[i];
      for (int c = 0; c < KT; c++)
        if (cnt[c]) P.clus[o] = uint16_t(c), P.mass[o] = float(cnt[c]) / 47.f, o++;
    }
  });
  double t1 = now_sec();
  // weights: raw hands per class; fit sample drawn proportional to weight
  std::vector<uint32_t> w = waugh_class_sizes(1, threads);
  std::vector<double> cum(n);
  double acc = 0;
  for (size_t i = 0; i < n; i++) cum[i] = (acc += w[i]);
  Rng rng(cfg.seed * 1000003ULL + 31);
  size_t ns = std::min<size_t>(size_t(std::max(1, cfg.pa_sample)), n * 4);
  std::vector<uint32_t> fit(ns);
  for (size_t s = 0; s < ns; s++) {
    double r = rng.uniform() * acc;
    fit[s] = uint32_t(std::upper_bound(cum.begin(), cum.end(), r) - cum.begin());
    if (fit[s] >= n) fit[s] = uint32_t(n - 1);
  }
  if (verbose)
    std::printf("  flop(pa): %zu Waugh flop hands, %zu sparse entries (%.1fs); fitting k=%d on %zu weighted samples, "
                "%d restarts\n",
                n, P.clus.size(), t1 - t0, K, ns, cfg.restarts),
        std::fflush(stdout);
  double obj = 0;
  std::vector<float> C = kmeans_emd(P, fit, g, K, cfg.kmeans_iters, cfg.restarts, cfg.seed + 3, threads, &obj, false);
  double t2 = now_sec();
  std::vector<uint16_t> asg = assign_emd(P, C, K, g, threads);
  // weighted objective over the whole population
  double t3 = now_sec();
  if (verbose)
    std::printf("  flop(pa): fit %.1fs (sample mean EMD %.5f), assigned all hands in %.1fs\n", t2 - t1,
                obj / double(ns), t3 - t2);
  // project into the legacy [canonical flop][combo] table
  const BoardIso& iso = A.flop_iso;
  A.flop_bucket.assign(iso.num_canon() * NUM_COMBOS, 0xFFFF);
  pfor(iso.num_canon(), threads, [&](size_t bi, int) {
    int b[3];
    for (int j = 0; j < 3; j++) b[j] = iso.canon_cards[bi][j];
    uint64_t dead = (1ull << b[0]) | (1ull << b[1]) | (1ull << b[2]);
    for (int h = 0; h < NUM_COMBOS; h++) {
      int hole[2] = {combos().hi[h], combos().lo[h]};
      if ((dead >> hole[0] & 1) || (dead >> hole[1] & 1)) continue;
      A.flop_bucket[bi * NUM_COMBOS + h] = asg[I.index(hole, b)];
    }
  });
  if (verbose) std::printf("  flop(pa): done in %.1fs\n", now_sec() - t0);
}

// ---- OCHS ----------------------------------------------------------------------------------

std::vector<int> ochs_opponent_clusters(uint64_t seed, int threads) {
  // Final-equity histogram of each preflop class over random river boards.
  const int BINS = 50, NBOARDS = 4000;
  std::vector<std::vector<double>> part(threads, std::vector<double>(169 * BINS, 0.0));
  std::vector<uint64_t> seeds(NBOARDS);
  Rng r0(seed * 31 + 17);
  for (auto& s : seeds) s = r0.next();
  pfor(NBOARDS, threads, [&](size_t i, int t) {
    Rng r(seeds[i]);
    int b[5];
    uint64_t used = 0;
    for (int j = 0; j < 5; j++) {
      int c;
      do c = int(r.below(52)); while (used >> c & 1);
      used |= 1ull << c;
      b[j] = c;
    }
    float e[NUM_COMBOS];
    river_ehs_all(b, e);
    for (int h = 0; h < NUM_COMBOS; h++) {
      if (e[h] < 0) continue;
      int cls = preflop_class(combos().hi[h], combos().lo[h]);
      int bin = std::min(BINS - 1, int(e[h] * BINS));
      part[t][size_t(cls) * BINS + bin] += 1;
    }
  });
  std::vector<double> cdf(169 * BINS, 0.0), wt(169, 0.0), meaneq(169, 0.0);
  for (int c = 0; c < 169; c++) {
    double tot = 0;
    for (int b = 0; b < BINS; b++)
      for (int t = 0; t < threads; t++) tot += part[t][size_t(c) * BINS + b];
    double accd = 0, m = 0;
    for (int b = 0; b < BINS; b++) {
      double v = 0;
      for (int t = 0; t < threads; t++) v += part[t][size_t(c) * BINS + b];
      accd += v;
      m += v * (b + 0.5) / BINS;
      cdf[size_t(c) * BINS + b] = accd / tot;
    }
    meaneq[c] = m / tot;
    int r = c / 13, col = c % 13;
    wt[c] = r == col ? 6 : (r > col ? 4 : 12);
  }
  // weighted k-means with L1-on-CDF assignment (1-D EMD) and mean-CDF update,
  // k-means++ seeding, 50 restarts, lowest objective kept
  const int k = OCHS_DIM;
  std::vector<int> best_asg(169, 0);
  double best_obj = 1e300;
  auto l1 = [&](const double* a, const double* b) {
    double s = 0;
    for (int j = 0; j < BINS; j++) s += std::fabs(a[j] - b[j]);
    return s;
  };
  for (int rs = 0; rs < 50; rs++) {
    Rng rng(seed * 101 + uint64_t(rs));
    std::vector<double> C(size_t(k) * BINS);
    std::vector<double> dmin(169, 1e30);
    int first = int(rng.below(169));
    std::copy(&cdf[size_t(first) * BINS], &cdf[size_t(first) * BINS] + BINS, &C[0]);
    for (int c = 1; c < k; c++) {
      double tot = 0;
      for (int i = 0; i < 169; i++) {
        dmin[i] = std::min(dmin[i], l1(&cdf[size_t(i) * BINS], &C[size_t(c - 1) * BINS]));
        tot += wt[i] * dmin[i] * dmin[i];
      }
      double r = rng.uniform() * tot;
      int pick = 168;
      for (int i = 0; i < 169; i++) {
        r -= wt[i] * dmin[i] * dmin[i];
        if (r <= 0) { pick = i; break; }
      }
      std::copy(&cdf[size_t(pick) * BINS], &cdf[size_t(pick) * BINS] + BINS, &C[size_t(c) * BINS]);
    }
    std::vector<int> asg(169, -1);
    double obj = 0;
    for (int it = 0; it < 100; it++) {
      bool ch = false;
      obj = 0;
      for (int i = 0; i < 169; i++) {
        int best = 0;
        double bd = 1e30;
        for (int c = 0; c < k; c++) {
          double d = l1(&cdf[size_t(i) * BINS], &C[size_t(c) * BINS]);
          if (d < bd) bd = d, best = c;
        }
        if (best != asg[i]) ch = true, asg[i] = best;
        obj += wt[i] * bd;
      }
      if (!ch) break;
      std::vector<double> s(size_t(k) * BINS, 0.0), cw(k, 0.0);
      for (int i = 0; i < 169; i++) {
        cw[asg[i]] += wt[i];
        for (int j = 0; j < BINS; j++) s[size_t(asg[i]) * BINS + j] += wt[i] * cdf[size_t(i) * BINS + j];
      }
      for (int c = 0; c < k; c++)
        if (cw[c] > 0)
          for (int j = 0; j < BINS; j++) C[size_t(c) * BINS + j] = s[size_t(c) * BINS + j] / cw[c];
    }
    std::vector<int> used(k, 0);
    for (int i = 0; i < 169; i++) used[asg[i]] = 1;
    bool all_used = std::count(used.begin(), used.end(), 1) == k;
    if (all_used && obj < best_obj) best_obj = obj, best_asg = asg;
  }
  // relabel clusters by increasing weighted mean equity
  std::vector<double> cm(k, 0.0), cw(k, 0.0);
  for (int i = 0; i < 169; i++) cm[best_asg[i]] += wt[i] * meaneq[i], cw[best_asg[i]] += wt[i];
  std::vector<int> ord(k);
  for (int c = 0; c < k; c++) ord[c] = c;
  std::sort(ord.begin(), ord.end(), [&](int a, int b) { return cm[a] / cw[a] < cm[b] / cw[b]; });
  std::vector<int> rank(k);
  for (int i = 0; i < k; i++) rank[ord[i]] = i;
  std::vector<int> out(169);
  for (int i = 0; i < 169; i++) out[i] = rank[best_asg[i]];
  return out;
}

void river_ochs_all(const int board[5], const int* occ, float* out) {
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
  uint32_t key[1081];
  uint8_t ca[1081], cb[1081], cc[1081];
  int n = 0;
  int total[OCHS_DIM] = {0};
  int with[OCHS_DIM][52] = {{0}};
  for (int i = 0; i < nr; i++) {
    HandAcc H = B;
    H.add(rem[i], T);
    for (int j = i + 1; j < nr; j++) {
      HandAcc G = H;
      G.add(rem[j], T);
      ca[n] = uint8_t(rem[i]);
      cb[n] = uint8_t(rem[j]);
      int c = occ[preflop_class(rem[i], rem[j])];
      cc[n] = uint8_t(c);
      total[c]++;
      with[c][rem[i]]++;
      with[c][rem[j]]++;
      key[n] = (uint32_t(eval_acc(G, T)) << 11) | uint32_t(n);
      n++;
    }
  }
  std::sort(key, key + n);
  for (int i = 0; i < NUM_COMBOS; i++) out[size_t(i) * OCHS_DIM] = -1.f;
  int lower_total[OCHS_DIM] = {0};
  int lower_with[OCHS_DIM][52] = {{0}}, group_with[OCHS_DIM][52] = {{0}};
  int group_total[OCHS_DIM];
  int g0 = 0;
  while (g0 < n) {
    uint32_t s = key[g0] >> 11;
    int g1 = g0;
    while (g1 < n && (key[g1] >> 11) == s) g1++;
    std::fill(group_total, group_total + OCHS_DIM, 0);
    for (int g = g0; g < g1; g++) {
      int i = int(key[g] & 2047);
      group_with[cc[i]][ca[i]]++;
      group_with[cc[i]][cb[i]]++;
      group_total[cc[i]]++;
    }
    for (int g = g0; g < g1; g++) {
      int i = int(key[g] & 2047);
      int a = ca[i], b = cb[i], own = cc[i];
      float* o = &out[size_t(combo_index(a, b)) * OCHS_DIM];
      for (int c = 0; c < OCHS_DIM; c++) {
        int self = c == own ? 1 : 0;
        int live = total[c] - with[c][a] - with[c][b] + self;
        int wins = lower_total[c] - lower_with[c][a] - lower_with[c][b];
        int ties = group_total[c] - group_with[c][a] - group_with[c][b] + self;
        o[c] = live > 0 ? (float(wins) + 0.5f * float(ties)) / float(live) : 0.5f;
      }
    }
    for (int g = g0; g < g1; g++) {
      int i = int(key[g] & 2047);
      group_with[cc[i]][ca[i]]--;
      group_with[cc[i]][cb[i]]--;
      lower_with[cc[i]][ca[i]]++;
      lower_with[cc[i]][cb[i]]++;
      lower_total[cc[i]]++;
    }
    g0 = g1;
  }
}

void river_ochs_brute(const int board[5], const int hole[2], const int* occ, float out[OCHS_DIM]) {
  int h7[7] = {hole[0], hole[1], board[0], board[1], board[2], board[3], board[4]};
  int hv = eval_n(h7, 7);
  uint64_t dead = (1ull << hole[0]) | (1ull << hole[1]);
  for (int i = 0; i < 5; i++) dead |= 1ull << board[i];
  double s[OCHS_DIM] = {0}, cnt[OCHS_DIM] = {0};
  for (int a = 0; a < 52; a++) {
    if (dead >> a & 1) continue;
    for (int b = a + 1; b < 52; b++) {
      if (dead >> b & 1) continue;
      int o7[7] = {a, b, board[0], board[1], board[2], board[3], board[4]};
      int ov = eval_n(o7, 7);
      int c = occ[preflop_class(a, b)];
      s[c] += hv > ov ? 1.0 : hv == ov ? 0.5 : 0.0;
      cnt[c] += 1;
    }
  }
  for (int c = 0; c < OCHS_DIM; c++) out[c] = cnt[c] > 0 ? float(s[c] / cnt[c]) : 0.5f;
}

void build_ochs_river(Abstraction& A, bool verbose) {
  const AbsConfig& cfg = A.cfg;
  if (cfg.river_k > 255) die("OCHS river needs river_k <= 255 (uint8 table)");
  const int threads = cfg.threads, K = cfg.river_k;
  double t0 = now_sec();
  std::vector<int> occ = ochs_opponent_clusters(cfg.seed, threads);
  if (verbose) {
    std::printf("  river(ochs): opponent clusters (class index r*13+c, rows r = A..2, cols c = A..2):\n");
    for (int r = 12; r >= 0; r--) {
      std::printf("    ");
      for (int c = 12; c >= 0; c--) std::printf("%d", occ[r * 13 + c]);
      std::printf("\n");
    }
  }
  // fit centers on sampled boards
  Rng rng(cfg.seed * 7919ULL + 77);
  std::vector<uint64_t> seeds(cfg.sample_rivers);
  for (auto& s : seeds) s = rng.next();
  std::vector<std::vector<float>> per(seeds.size());
  pfor(seeds.size(), threads, [&](size_t i, int) {
    Rng r(seeds[i]);
    int b[5];
    uint64_t used = 0;
    for (int j = 0; j < 5; j++) {
      int c;
      do c = int(r.below(52)); while (used >> c & 1);
      used |= 1ull << c;
      b[j] = c;
    }
    std::vector<float> o(size_t(NUM_COMBOS) * OCHS_DIM);
    river_ochs_all(b, occ.data(), o.data());
    for (int h = 0; h < NUM_COMBOS; h++)
      if (o[size_t(h) * OCHS_DIM] >= 0) per[i].insert(per[i].end(), &o[size_t(h) * OCHS_DIM], &o[size_t(h) * OCHS_DIM] + OCHS_DIM);
  });
  std::vector<float> X;
  for (auto& v : per) X.insert(X.end(), v.begin(), v.end()), v.clear(), v.shrink_to_fit();
  size_t n = X.size() / OCHS_DIM;
  double inertia = 0;
  std::vector<float> C = kmeans(X, nullptr, n, OCHS_DIM, K, cfg.kmeans_iters * 2, cfg.seed + 5, threads, &inertia);
  X.clear();
  X.shrink_to_fit();
  // order centers by mean OCHS so bucket ids still rise with strength
  std::vector<int> ord(K);
  for (int c = 0; c < K; c++) ord[c] = c;
  auto msum = [&](int c) {
    double s = 0;
    for (int j = 0; j < OCHS_DIM; j++) s += C[size_t(c) * OCHS_DIM + j];
    return s;
  };
  std::sort(ord.begin(), ord.end(), [&](int a, int b) { return msum(a) < msum(b); });
  std::vector<float> C2(C.size());
  for (int i = 0; i < K; i++)
    std::copy(&C[size_t(ord[i]) * OCHS_DIM], &C[size_t(ord[i]) * OCHS_DIM] + OCHS_DIM, &C2[size_t(i) * OCHS_DIM]);
  A.river_centers = C2;  // K x 8, saved in the cache file
  double t1 = now_sec();
  if (verbose)
    std::printf("  river(ochs): k-means on %zu points in %.1fs, mean sq dist %.5f\n", n, t1 - t0,
                inertia / double(n)),
        std::fflush(stdout);
  if (A.river_iso.k != 5) A.river_iso.build(5);
  size_t nb = A.river_iso.num_canon();
  A.river_bucket.assign(nb * NUM_COMBOS, 0xFF);
  pfor(nb, threads, [&](size_t i, int) {
    int b[5];
    for (int j = 0; j < 5; j++) b[j] = A.river_iso.canon_cards[i][j];
    std::vector<float> o(size_t(NUM_COMBOS) * OCHS_DIM);
    river_ochs_all(b, occ.data(), o.data());
    for (int h = 0; h < NUM_COMBOS; h++)
      if (o[size_t(h) * OCHS_DIM] >= 0)
        A.river_bucket[i * NUM_COMBOS + h] = uint8_t(nearest_center(&o[size_t(h) * OCHS_DIM], C2.data(), K, OCHS_DIM));
  });
  if (verbose) std::printf("  river(ochs): table for %zu canonical rivers in %.1fs\n", nb, now_sec() - t1);
}

}  // namespace bp
