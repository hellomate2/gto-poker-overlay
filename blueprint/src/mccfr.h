// ============================================================
// mccfr.h: multithreaded external-sampling MCCFR with the practical
// modifications Pluribus used (Brown & Sandholm, Science 2019, supplementary
// Algorithm 1 "MCCFR with negative-regret pruning"):
//
//   * External sampling. Each iteration, for each player p (the
//     "traverser"), chance is sampled once (a full deal, cards fixed up front),
//     every action of p is explored, and the opponent's actions are sampled
//     from the current strategy. Regrets update only at p's infosets.
//   * Average strategy, external-sampling style: when the traversal passes an
//     opponent infoset, add the opponent's current strategy to its running
//     sum (Lanctot 2013, "simple averaging"; the expected visit rate is
//     proportional to the opponent's own reach, which is the weight the
//     average strategy needs).
//   * Linear CFR, Pluribus style: while iteration < lcfr_until, every
//     discount_every iterations, multiply all regrets and strategy sums by
//     d / (d + 1) where d = iteration / discount_every. This makes iteration
//     t's contribution proportional to roughly t (linear weighting) without
//     storing per-iteration weights.
//   * Negative-regret pruning: after prune_after iterations, 95% of
//     traversals skip any traverser action whose regret is below
//     prune_threshold, unless the action ends the hand or the node is on the
//     last street. Pruned actions already have zero probability under regret
//     matching, so the node value is unchanged; only their (very negative)
//     regret stops being refreshed.
//   * Regrets are int32 with a floor (regret_floor) so permanently bad
//     actions cannot run away to -infinity and can still recover. Values are
//     rounded from utility * regret_scale and saturate at INT32_MAX.
//   * Lock-free shared tables ("Hogwild"): all threads read and write the same
//     regret and average arrays with relaxed atomics (see common.h).
//   * Periodic checkpoint + resume: the whole state (iteration, effective
//     weight, regrets, sums) round-trips through one file, written to a temp
//     path and renamed so a crash never leaves a torn checkpoint.
// ============================================================
#pragma once

#include <algorithm>
#include <atomic>
#include <functional>
#include <thread>
#include <vector>

#include "games.h"
#include "tree.h"

namespace bp {

struct McfrConfig {
  int threads = 1;
  uint64_t seed = 1;
  double regret_scale = 1.0;           // int regret units per utility unit
  int64_t discount_every = 0;          // 0 disables Linear-CFR discounting
  int64_t lcfr_until = 0;
  int64_t prune_after = -1;            // < 0 disables pruning
  double prune_prob = 0.95;
  int32_t prune_threshold = -300000000;  // Pluribus constants (chip units, BB = 100)
  int32_t regret_floor = -310000000;
};

inline void regret_match(const int32_t* R, int n, double* out) {
  double sum = 0;
  for (int a = 0; a < n; a++) {
    int32_t r = aload(R + a);
    out[a] = r > 0 ? double(r) : 0.0;
    sum += out[a];
  }
  if (sum > 0) {
    for (int a = 0; a < n; a++) out[a] /= sum;
  } else {
    for (int a = 0; a < n; a++) out[a] = 1.0 / n;
  }
}

template <class Sampler>
class Trainer {
 public:
  const BettingTree& tree;
  Sampler sampler;
  McfrConfig cfg;
  std::vector<int32_t> R;   // cumulative regrets, int32
  std::vector<double> S;    // average-strategy sums
  int64_t iter = 0;         // completed iterations (each = one traversal per player)
  double weight = 0;        // effective iteration count after discounting
  std::atomic<uint64_t> visits{0};
  std::atomic<uint64_t> explored{0}, pruned{0};  // traverser actions (pruning stats)

  Trainer(const BettingTree& t, const Sampler& s, const McfrConfig& c)
      : tree(t), sampler(s), cfg(c), R(t.num_slots, 0), S(t.num_slots, 0.0) {}

  static size_t bytes_per_slot() { return sizeof(int32_t) + sizeof(double); }

  // Run until `target_iter` iterations are done or `max_seconds` elapse,
  // calling on_chunk after every chunk (logging / checkpoints).
  void run(int64_t target_iter, double max_seconds, int64_t chunk,
           const std::function<void(Trainer&)>& on_chunk) {
    double t_end = now_sec() + max_seconds;
    while (iter < target_iter && now_sec() < t_end) {
      int64_t n = std::min(chunk, target_iter - iter);
      if (cfg.discount_every > 0 && iter < cfg.lcfr_until) {
        int64_t next = (iter / cfg.discount_every + 1) * cfg.discount_every;
        n = std::min(n, next - iter);
      }
      run_chunk(n);
      iter += n;
      weight += double(n);
      if (cfg.discount_every > 0 && iter % cfg.discount_every == 0 && iter <= cfg.lcfr_until) {
        double d = double(iter / cfg.discount_every);
        discount(d / (d + 1.0));
      }
      if (on_chunk) on_chunk(*this);
    }
  }

  void run_chunk(int64_t n) {
    int T = std::max(1, cfg.threads);
    bool prune_on = cfg.prune_after >= 0 && iter >= cfg.prune_after;
    auto work = [&](int tid, int64_t count) {
      Rng rng(cfg.seed ^ (uint64_t(iter) * 0x9E3779B97F4A7C15ULL) ^ (uint64_t(tid + 1) << 40));
      Deal d;
      Counters cnt;
      for (int64_t k = 0; k < count; k++)
        for (int p = 0; p < 2; p++) {
          sampler.sample(rng, d);
          bool prune = prune_on && rng.uniform() < cfg.prune_prob;
          traverse(0, p, d, rng, prune, cnt);
        }
      visits += cnt.visits;
      explored += cnt.explored;
      pruned += cnt.pruned;
    };
    if (T == 1) {
      work(0, n);
      return;
    }
    std::vector<std::thread> pool;
    for (int t = 0; t < T; t++) {
      int64_t cnt = n / T + (t < n % T ? 1 : 0);
      pool.emplace_back(work, t, cnt);
    }
    for (auto& th : pool) th.join();
  }

  struct Counters {
    uint64_t visits = 0, explored = 0, pruned = 0;
  };

  double traverse(uint32_t ni, int p, const Deal& d, Rng& rng, bool prune, Counters& cnt) {
    const Node& n = tree.nodes[ni];
    if (n.type != DECISION) return terminal_utility(n, p, d.winner);
    cnt.visits++;
    const int pl = n.player, na = n.nact;
    const uint64_t base = n.slot + uint64_t(d.bucket[pl][n.street]) * na;
    int32_t* Rr = &R[base];
    double sigma[MAX_ACTIONS];
    regret_match(Rr, na, sigma);
    if (pl == p) {
      double va[MAX_ACTIONS];
      bool explored[MAX_ACTIONS];
      double v = 0;
      const bool last_street = n.street + 1 >= tree.cfg.nstreets;
      for (int a = 0; a < na; a++) {
        const Node& c = tree.nodes[n.child + a];
        if (prune && !last_street && c.type == DECISION && aload(Rr + a) < cfg.prune_threshold) {
          explored[a] = false;
          cnt.pruned++;
          continue;
        }
        explored[a] = true;
        cnt.explored++;
        va[a] = traverse(n.child + a, p, d, rng, prune, cnt);
        v += sigma[a] * va[a];
      }
      for (int a = 0; a < na; a++) {
        if (!explored[a]) continue;
        int64_t nv = int64_t(aload(Rr + a)) + std::llround((va[a] - v) * cfg.regret_scale);
        if (nv < cfg.regret_floor) nv = cfg.regret_floor;
        if (nv > INT32_MAX) nv = INT32_MAX;
        astore(Rr + a, int32_t(nv));
      }
      return v;
    }
    double* Sr = &S[base];
    for (int a = 0; a < na; a++) astore(Sr + a, aload(Sr + a) + sigma[a]);
    double r = rng.uniform(), acc = 0;
    int pick = na - 1;
    for (int a = 0; a < na; a++) {
      acc += sigma[a];
      if (r < acc) {
        pick = a;
        break;
      }
    }
    return traverse(n.child + pick, p, d, rng, prune, cnt);
  }

  void discount(double f) {
    weight *= f;
    const size_t N = R.size();
    int T = std::max(1, cfg.threads);
    auto work = [&](size_t lo, size_t hi) {
      for (size_t i = lo; i < hi; i++) {
        R[i] = int32_t(std::llround(double(R[i]) * f));
        S[i] *= f;
      }
    };
    std::vector<std::thread> pool;
    for (int t = 0; t < T; t++) pool.emplace_back(work, N * t / T, N * (t + 1) / T);
    for (auto& th : pool) th.join();
  }

  // Normalized average strategy at an infoset; falls back to the current
  // (regret-matching) strategy if the infoset was never averaged.
  void average(uint64_t base, int na, double* out) const {
    double s = 0;
    for (int a = 0; a < na; a++) s += S[base + a];
    if (s > 0) {
      for (int a = 0; a < na; a++) out[a] = S[base + a] / s;
    } else {
      regret_match(&R[base], na, out);
    }
  }
  void current(uint64_t base, int na, double* out) const { regret_match(&R[base], na, out); }

  // Exploitability proxy for games too large for an exact best response:
  // sum over infosets of the largest positive regret, divided by the
  // effective iteration count, in utility units. For CFR the full-game
  // exploitability is bounded by (a constant times) the sum of these
  // per-infoset average regrets; with sampling and imperfect recall it is a
  // trend indicator only, not a bound.
  double avg_positive_regret() const {
    double tot = 0;
    for (const Node& n : tree.nodes) {
      if (n.type != DECISION) continue;
      int B = tree.buckets[n.street];
      for (int b = 0; b < B; b++) {
        int32_t m = 0;
        for (int a = 0; a < n.nact; a++) m = std::max(m, R[n.slot + uint64_t(b) * n.nact + a]);
        tot += m;
      }
    }
    return weight > 0 ? tot / cfg.regret_scale / weight : 0;
  }

  // ---- checkpoints ----
  bool save(const std::string& path, uint64_t cfg_hash) const {
    std::string tmp = path + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    const char magic[8] = {'G', 'P', 'O', 'C', 'K', 'P', 'T', '1'};
    uint64_t ns = R.size();
    bool ok = std::fwrite(magic, 1, 8, f) == 8 && std::fwrite(&cfg_hash, 8, 1, f) == 1 &&
              std::fwrite(&iter, 8, 1, f) == 1 && std::fwrite(&weight, 8, 1, f) == 1 &&
              std::fwrite(&ns, 8, 1, f) == 1 && std::fwrite(R.data(), 4, ns, f) == ns &&
              std::fwrite(S.data(), 8, ns, f) == ns;
    ok = (std::fclose(f) == 0) && ok;
    return ok && std::rename(tmp.c_str(), path.c_str()) == 0;
  }
  bool load(const std::string& path, uint64_t cfg_hash) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    char magic[8];
    uint64_t h, ns;
    int64_t it;
    double w;
    bool ok = std::fread(magic, 1, 8, f) == 8 && std::memcmp(magic, "GPOCKPT1", 8) == 0 &&
              std::fread(&h, 8, 1, f) == 1 && h == cfg_hash && std::fread(&it, 8, 1, f) == 1 &&
              std::fread(&w, 8, 1, f) == 1 && std::fread(&ns, 8, 1, f) == 1 && ns == R.size() &&
              std::fread(R.data(), 4, ns, f) == ns && std::fread(S.data(), 8, ns, f) == ns;
    std::fclose(f);
    if (ok) {
      iter = it;
      weight = w;
    }
    return ok;
  }
};

// ---- exact evaluation for small games (Kuhn, Leduc) -----------------------------
//
// Strategy profile = a function (slot base, nact, out) -> probabilities.
// best_response_value(p) computes max over p's pure strategies of p's
// expected utility against the fixed opponent profile, by walking the tree
// once with a vector over all deals: at p's nodes it picks, per bucket, the
// action maximizing the reach-weighted sum over the deals in that bucket
// (deals in the same bucket at the same node form one infoset).
// exploitability = (BR_0 + BR_1) / 2, which is 0 exactly at a Nash
// equilibrium of a two-player zero-sum game (the game value cancels).

using StrategyFn = std::function<void(uint64_t, int, double*)>;

class ExactEval {
 public:
  ExactEval(const BettingTree& t, std::vector<WeightedDeal> deals) : tree(t), deals(std::move(deals)) {}

  double best_response_value(int p, const StrategyFn& sigma) const {
    std::vector<double> reach(deals.size());
    for (size_t i = 0; i < deals.size(); i++) reach[i] = deals[i].prob;
    std::vector<double> out = br(0, p, reach, sigma);
    double s = 0;
    for (double v : out) s += v;
    return s;
  }
  double exploitability(const StrategyFn& sigma) const {
    return 0.5 * (best_response_value(0, sigma) + best_response_value(1, sigma));
  }
  double value_p0(const StrategyFn& sigma) const {
    double s = 0;
    for (const auto& wd : deals) s += wd.prob * ev(0, wd.d, sigma);
    return s;
  }

 private:
  const BettingTree& tree;
  std::vector<WeightedDeal> deals;

  double ev(uint32_t ni, const Deal& d, const StrategyFn& sigma) const {
    const Node& n = tree.nodes[ni];
    if (n.type != DECISION) return terminal_utility(n, 0, d.winner);
    double pr[MAX_ACTIONS];
    sigma(n.slot + uint64_t(d.bucket[n.player][n.street]) * n.nact, n.nact, pr);
    double v = 0;
    for (int a = 0; a < n.nact; a++)
      if (pr[a] > 0) v += pr[a] * ev(n.child + a, d, sigma);
    return v;
  }

  std::vector<double> br(uint32_t ni, int p, const std::vector<double>& reach, const StrategyFn& sigma) const {
    const Node& n = tree.nodes[ni];
    const size_t D = deals.size();
    std::vector<double> out(D, 0.0);
    if (n.type != DECISION) {
      for (size_t i = 0; i < D; i++)
        if (reach[i] != 0) out[i] = reach[i] * terminal_utility(n, p, deals[i].d.winner);
      return out;
    }
    const int na = n.nact;
    if (n.player == p) {
      std::vector<std::vector<double>> child(na);
      for (int a = 0; a < na; a++) child[a] = br(n.child + a, p, reach, sigma);
      int B = tree.buckets[n.street];
      std::vector<double> best(size_t(B) * na, 0.0);
      for (size_t i = 0; i < D; i++)
        for (int a = 0; a < na; a++) best[size_t(deals[i].d.bucket[p][n.street]) * na + a] += child[a][i];
      std::vector<int> arg(B, 0);
      for (int b = 0; b < B; b++)
        for (int a = 1; a < na; a++)
          if (best[size_t(b) * na + a] > best[size_t(b) * na + arg[b]]) arg[b] = a;
      for (size_t i = 0; i < D; i++) out[i] = child[arg[deals[i].d.bucket[p][n.street]]][i];
      return out;
    }
    for (int a = 0; a < na; a++) {
      std::vector<double> r2(D);
      bool any = false;
      for (size_t i = 0; i < D; i++) {
        double pr[MAX_ACTIONS];
        sigma(n.slot + uint64_t(deals[i].d.bucket[n.player][n.street]) * na, na, pr);
        r2[i] = reach[i] * pr[a];
        any |= r2[i] != 0;
      }
      if (!any) continue;
      std::vector<double> c = br(n.child + a, p, r2, sigma);
      for (size_t i = 0; i < D; i++) out[i] += c[i];
    }
    return out;
  }
};

}  // namespace bp
