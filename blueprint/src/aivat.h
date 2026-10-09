// ============================================================
// aivat.h: AIVAT variance reduction for two-player games on a BettingTree
// (Burch, Schmid, Moravcik, Morrill, Bowling, "AIVAT: A New Variance
// Reduction Technique for Agent Evaluation in Imperfect Information Games",
// AAAI 2018, https://arxiv.org/abs/1612.06915).
//
// The estimate of player p's result for one hand is
//
//   u_p(z)                                       observed payoff
//   + sum over chance events c on the path of     E_{c'}[V(h c')] - V(h c)
//   + sum over decisions of KNOWN players of      sum_a sigma(a|I) V(h a) - V(h a_obs)
//
// Each correction has conditional expectation zero (chance follows its true
// distribution and a known player follows sigma), so the estimate is
// unbiased for ANY value function V; a better V only lowers the variance.
// Opponent decisions whose strategy is unknown get no correction.
//
// V(h) here is a depth-limited value: the expected payoff for p over the rest
// of the CURRENT street, with both players following `pol` (the true strategy
// of a known player, a model, e.g. our blueprint, for an unknown one), and
// every node where the street ends valued by showdown equity times the pot
// (pot * eq_p - committed_p; fold nodes are exact). `lookahead_from` = s
// makes street-end nodes leading into street s or later recurse through the
// chance event instead (hold'em: s = 3 values turn-end nodes by every river
// card and the river betting). With exact_depth = true
// (small games only) V recurses through the next chance event instead, which
// makes V the true expected value when both strategies are known; the
// estimate then has zero variance, which is the strongest possible check of
// the bookkeeping.
//
// After the hand all cards are known (local matches deal them), so V may use
// both players' cards. The "imaginary observations" refinement of the paper
// (averaging over every private hand we could hold) is not implemented.
//
// A card model supplies the chance side of the game (see KuhnModel and
// LeducModel below and HoldemModel in aivat_holdem.h):
//   struct State;                                    cards dealt so far
//   State prefix(const State& full, int street)      cards visible on `street`
//   void buckets(const State&, int street, int bk[2])
//   int winner(const State& full)                    0, 1 or 2 (tie)
//   double equity(const State&, int street, int p)   P(p wins) + P(tie)/2 over
//                                                    the cards still to come
//   for_each_deal(f(State, w))                       street-0 deals, sum w = 1
//   for_each_board(State, street, Rng&, f(State, w)) cards revealed at the
//                                                    start of `street` (exact
//                                                    or an unbiased sample)
//   for_each_full_deal(f(State, w))                  (exact enumerator only)
// ============================================================
#pragma once

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <vector>

#include "tree.h"

namespace bp {

// Probabilities of every action at (node, bucket of the actor).
using PolicyFn = std::function<void(uint32_t node, int bucket, double* out)>;

// Pick an action from probabilities the way every sampler here does: the
// first action whose running sum exceeds r, the last action otherwise. The
// probability of action a is then exactly what effective_probs() returns.
inline int sample_action(const double* pr, int na, double r) {
  double acc = 0;
  for (int a = 0; a < na; a++) {
    acc += pr[a];
    if (r < acc) return a;
  }
  return na - 1;
}
// Exact selection probabilities of sample_action for r uniform in [0, 1).
inline void effective_probs(const double* pr, int na, double* out) {
  double acc = 0, prev = 0;
  for (int a = 0; a < na; a++) {
    acc += pr[a];
    double cur = a == na - 1 ? 1.0 : std::min(1.0, std::max(0.0, acc));
    out[a] = std::max(0.0, cur - prev);
    prev = std::max(prev, cur);
  }
}

template <class Model>
class Aivat {
 public:
  using State = typename Model::State;

  struct Terms {
    double plain = 0, chance = 0, action = 0;
    double total() const { return plain + chance + action; }
  };
  struct Scratch {
    std::vector<double> val;
    std::vector<uint32_t> stamp;
    uint32_t cur = 0;
  };

  // pol[i]: strategy (known player) or model (unknown player) of position i.
  Aivat(const BettingTree& t, const Model& m, PolicyFn pol0, PolicyFn pol1, bool known0, bool known1,
        bool exact_depth = false, int lookahead_from = -1, bool lookahead_obs_only = false)
      : tree(t), M(m), exact(exact_depth), lookahead_store_only(lookahead_obs_only) {
    // Street-end nodes whose next street is >= exact_from are valued by
    // recursing through the next chance event instead of by equity.
    exact_from = lookahead_from >= 0 ? lookahead_from : exact ? 1 : tree.cfg.nstreets;
    pol[0] = std::move(pol0);
    pol[1] = std::move(pol1);
    known[0] = known0;
    known[1] = known1;
    Rng rng(0xA17A7);
    Scratch sc = scratch();
    for (int p = 0; p < 2; p++) {
      double e = 0;
      M.for_each_deal([&](const State& st, double w) {
        Ctx c = ctx(st, 0, p, false, sc, rng);
        e += w * walk(0, c);
      });
      root_expect[p] = e;
    }
  }

  Scratch scratch() const {
    Scratch s;
    s.val.assign(tree.nodes.size(), 0.0);
    s.stamp.assign(tree.nodes.size(), 0);
    return s;
  }

  // Score one finished hand. `full` holds every card of the deal, `path` the
  // node indices from the root (path[0] == 0) to the terminal node, p the
  // position whose result is estimated. `rng` drives sampled chance
  // expectations (models that enumerate exactly never touch it).
  Terms score(const State& full, const std::vector<uint32_t>& path, int p, Rng& rng, Scratch& sc) const {
    Terms t;
    const int last = tree.cfg.nstreets - 1;
    const Node& z = tree.nodes[path.back()];
    t.plain = terminal_utility(z, p, z.type == SHOWDOWN ? M.winner(full) : 0);
    if (++sc.cur == 0) {
      std::fill(sc.stamp.begin(), sc.stamp.end(), 0);
      sc.cur = 1;
    }
    size_t i = 0;
    int s = 0;
    State prev = M.prefix(full, 0);
    for (;;) {
      State st = M.prefix(full, s);
      // chance correction for the cards revealed at the start of street s
      double e = 0;
      if (s == 0) {
        e = root_expect[p];
      } else {
        M.for_each_board(prev, s, rng, [&](const State& st2, double w) {
          Ctx c = ctx(st2, s, p, false, sc, rng);
          e += w * walk(path[i], c);
        });
      }
      Ctx c = ctx(st, s, p, true, sc, rng);
      double vobs = walk(path[i], c);
      if (lookahead_store_only) {
        // the chance term must use the same V as its expectation
        Ctx c2 = ctx(st, s, p, false, sc, rng);
        vobs = walk(path[i], c2);
      }
      t.chance += e - vobs;
      // action corrections on street s
      for (; tree.nodes[path[i]].type == DECISION && tree.nodes[path[i]].street == s; i++) {
        const Node& n = tree.nodes[path[i]];
        if (!known[n.player]) continue;
        double pr[MAX_ACTIONS];
        probs(n.player, path[i], c.bk[n.player], n.nact, pr);
        double ev = 0;
        for (int a = 0; a < n.nact; a++) ev += pr[a] * stored(sc, n.child + a);
        t.action += ev - stored(sc, path[i + 1]);
      }
      const Node& nx = tree.nodes[path[i]];
      if (nx.type == DECISION) {  // next street
        prev = st;
        s++;
        continue;
      }
      // Terminal. An all-in before the last street: the remaining cards are
      // chance events with no decisions; correct each one with equity.
      if (nx.type == SHOWDOWN && s < last) {
        State before = st;
        for (int s2 = s + 1; s2 <= last; s2++) {
          State now = M.prefix(full, s2);
          double ee = 0;
          M.for_each_board(before, s2, rng,
                           [&](const State& st2, double w) { ee += w * showdown_value(nx, st2, s2, p); });
          t.chance += ee - showdown_value(nx, now, s2, p);
          before = now;
        }
      }
      break;
    }
    return t;
  }

  const BettingTree& tree;
  const Model& M;
  PolicyFn pol[2];
  bool known[2];
  bool exact;
  // Use the lookahead only in the observed-path walk, i.e. for the action
  // corrections, and equity cutoffs for every chance term (each correction
  // stays zero-mean on its own). Fixed at construction: the root
  // expectation must be computed with the same V as the chance terms.
  const bool lookahead_store_only;
  int exact_from = 0;
  double root_expect[2] = {0, 0};

 private:
  struct Ctx {
    const State* st;
    int street, p;
    int bk[2];
    bool store;
    double eq;
    Scratch* sc;
    Rng* rng;
  };
  Ctx ctx(const State& st, int s, int p, bool store, Scratch& sc, Rng& rng) const {
    Ctx c;
    c.st = &st;
    c.street = s;
    c.p = p;
    M.buckets(st, s, c.bk);
    c.store = store;
    c.eq = std::numeric_limits<double>::quiet_NaN();
    c.sc = &sc;
    c.rng = &rng;
    return c;
  }
  // The selection probabilities of sample_action() for the policy's
  // numbers. A float policy table sums to 1 only to about 1e-7; using the
  // raw numbers would leave a bias of that relative size in the corrections.
  void probs(int pl, uint32_t ni, int bucket, int na, double* out) const {
    double raw[MAX_ACTIONS];
    pol[pl](ni, bucket, raw);
    effective_probs(raw, na, out);
  }
  double stored(const Scratch& sc, uint32_t ni) const {
    if (sc.stamp[ni] != sc.cur) die("aivat: value of node " + std::to_string(ni) + " was not computed");
    return sc.val[ni];
  }
  double eqval(const Node& n, Ctx& c) const {
    if (std::isnan(c.eq)) c.eq = M.equity(*c.st, c.street, c.p);
    return c.eq * double(n.contrib[0] + n.contrib[1]) - double(n.contrib[c.p]);
  }
  // Value of an all-in showdown node with the cards of street s known.
  double showdown_value(const Node& n, const State& st, int s, int p) const {
    if (s == tree.cfg.nstreets - 1) return terminal_utility(n, p, M.winner(st));
    return M.equity(st, s, p) * double(n.contrib[0] + n.contrib[1]) - double(n.contrib[p]);
  }
  double walk(uint32_t ni, Ctx& c) const {
    const Node& n = tree.nodes[ni];
    double v;
    if (n.type == FOLD) {
      v = terminal_utility(n, c.p, 0);
    } else if (n.type == SHOWDOWN) {
      v = c.street == tree.cfg.nstreets - 1 ? terminal_utility(n, c.p, M.winner(*c.st)) : eqval(n, c);
    } else if (n.street != c.street) {
      if (n.street >= exact_from && (c.store || !lookahead_store_only)) {
        v = 0;
        M.for_each_board(*c.st, n.street, *c.rng, [&](const State& st2, double w) {
          Ctx c2 = ctx(st2, n.street, c.p, false, *c.sc, *c.rng);
          v += w * walk(ni, c2);
        });
      } else {
        v = eqval(n, c);
      }
    } else {
      double pr[MAX_ACTIONS];
      probs(n.player, ni, c.bk[n.player], n.nact, pr);
      v = 0;
      for (int a = 0; a < n.nact; a++) {
        // Stored walks visit every child: the observed action of an unknown
        // player may have probability zero under its model.
        if (!c.store && pr[a] == 0) continue;
        double va = walk(n.child + a, c);
        v += pr[a] * va;
      }
    }
    if (c.store) {
      c.sc->val[ni] = v;
      c.sc->stamp[ni] = c.sc->cur;
    }
    return v;
  }
};

// ---- small games ----------------------------------------------------------------

// Kuhn: cards 0..2 (J, Q, K), one each; one betting round.
struct KuhnModel {
  struct State {
    int c[2];
  };
  State prefix(const State& f, int) const { return f; }
  void buckets(const State& s, int, int bk[2]) const {
    bk[0] = s.c[0];
    bk[1] = s.c[1];
  }
  int winner(const State& s) const { return s.c[0] > s.c[1] ? 0 : 1; }
  double equity(const State& s, int, int p) const { return winner(s) == p ? 1.0 : 0.0; }
  template <class F>
  void for_each_deal(F f) const {
    for (int a = 0; a < 3; a++)
      for (int b = 0; b < 3; b++)
        if (a != b) f(State{{a, b}}, 1.0 / 6.0);
  }
  template <class F>
  void for_each_full_deal(F f) const {
    for_each_deal(f);
  }
  template <class F>
  void for_each_board(const State&, int, Rng&, F) const {
    die("kuhn has no board");
  }
  State sample_full(Rng& rng) const {
    int a = int(rng.below(3)), b = int(rng.below(2));
    if (b >= a) b++;
    return State{{a, b}};
  }
};

// Leduc: deck {J,J,Q,Q,K,K} as cards 0..5 (rank = card / 2); one private
// card each, one public card after round 1. Buckets and the showdown rule
// match LeducSampler in games.h.
struct LeducModel {
  struct State {
    int c[2];
    int pub;  // -1 until dealt
  };
  State prefix(const State& f, int street) const {
    State s = f;
    if (street == 0) s.pub = -1;
    return s;
  }
  void buckets(const State& s, int street, int bk[2]) const {
    for (int i = 0; i < 2; i++) bk[i] = street == 0 ? s.c[i] / 2 : (s.c[i] / 2) * 3 + s.pub / 2;
  }
  static int winner_of(int c0, int c1, int pub) {
    int r0 = c0 / 2, r1 = c1 / 2, rp = pub / 2;
    if (r0 == rp) return 0;
    if (r1 == rp) return 1;
    if (r0 == r1) return 2;
    return r0 > r1 ? 0 : 1;
  }
  int winner(const State& s) const { return winner_of(s.c[0], s.c[1], s.pub); }
  static double share(int w, int p) { return w == 2 ? 0.5 : (w == p ? 1.0 : 0.0); }
  double equity(const State& s, int street, int p) const {
    if (street >= 1) return share(winner(s), p);
    double e = 0;
    int n = 0;
    for (int x = 0; x < 6; x++)
      if (x != s.c[0] && x != s.c[1]) e += share(winner_of(s.c[0], s.c[1], x), p), n++;
    return e / n;
  }
  template <class F>
  void for_each_deal(F f) const {
    for (int a = 0; a < 6; a++)
      for (int b = 0; b < 6; b++)
        if (a != b) f(State{{a, b}, -1}, 1.0 / 30.0);
  }
  template <class F>
  void for_each_full_deal(F f) const {
    for (int a = 0; a < 6; a++)
      for (int b = 0; b < 6; b++)
        for (int x = 0; x < 6; x++)
          if (a != b && a != x && b != x) f(State{{a, b}, x}, 1.0 / 120.0);
  }
  template <class F>
  void for_each_board(const State& s, int, Rng&, F f) const {
    for (int x = 0; x < 6; x++)
      if (x != s.c[0] && x != s.c[1]) f(State{{s.c[0], s.c[1]}, x}, 0.25);
  }
  State sample_full(Rng& rng) const {
    int c[3];
    uint32_t used = 0;
    for (int i = 0; i < 3; i++) {
      do c[i] = int(rng.below(6)); while (used >> c[i] & 1);
      used |= 1u << c[i];
    }
    return State{{c[0], c[1]}, c[2]};
  }
};

// ---- exact moments by enumeration (small games) ------------------------------------
// Walks every full deal and every action path with its true probability
// under `play` (the strategies the players actually use) and returns the
// exact mean and variance of the plain payoff and of the AIVAT estimate for
// position p. The reference for unbiasedness and SD-reduction tests.
struct AivatMoments {
  double mean_plain = 0, var_plain = 0, mean_est = 0, var_est = 0;
  double min_est = 1e300, max_est = -1e300;  // over paths with probability > 0
};

template <class Model>
AivatMoments aivat_exact_moments(const Aivat<Model>& av, const PolicyFn play[2], int p) {
  using State = typename Model::State;
  const BettingTree& tree = av.tree;
  double s1 = 0, s2 = 0, e1 = 0, e2 = 0, lo = 1e300, hi = -1e300;
  Rng rng(1);
  auto sc = av.scratch();
  std::vector<uint32_t> path;
  std::function<void(uint32_t, double, const State&)> rec = [&](uint32_t ni, double prob, const State& full) {
    path.push_back(ni);
    const Node& n = tree.nodes[ni];
    if (n.type != DECISION) {
      auto t = av.score(full, path, p, rng, sc);
      s1 += prob * t.plain;
      s2 += prob * t.plain * t.plain;
      double e = t.total();
      e1 += prob * e;
      e2 += prob * e * e;
      lo = std::min(lo, e);
      hi = std::max(hi, e);
    } else {
      int bk[2];
      av.M.buckets(av.M.prefix(full, n.street), n.street, bk);
      double pr[MAX_ACTIONS], eff[MAX_ACTIONS];
      play[n.player](ni, bk[n.player], pr);
      effective_probs(pr, n.nact, eff);
      for (int a = 0; a < n.nact; a++)
        if (eff[a] > 0) rec(n.child + a, prob * eff[a], full);
    }
    path.pop_back();
  };
  av.M.for_each_full_deal([&](const State& full, double w) { rec(0, w, full); });
  AivatMoments m;
  m.mean_plain = s1;
  m.var_plain = std::max(0.0, s2 - s1 * s1);
  m.mean_est = e1;
  m.var_est = std::max(0.0, e2 - e1 * e1);
  m.min_est = lo;
  m.max_est = hi;
  return m;
}

// ---- running statistics -------------------------------------------------------------
struct RunStat {
  // Welford's running mean and sum of squared deviations (Chan et al. for
  // merges), so an SD near zero is not lost to cancellation.
  double n = 0, m = 0, m2 = 0;
  void add(double x) {
    n += 1;
    double d = x - m;
    m += d / n;
    m2 += d * (x - m);
  }
  void merge(const RunStat& o) {
    if (o.n == 0) return;
    double N = n + o.n, d = o.m - m;
    m += d * o.n / N;
    m2 += o.m2 + d * d * n * o.n / N;
    n = N;
  }
  double mean() const { return m; }
  double sd() const { return n < 2 ? 0 : std::sqrt(std::max(0.0, m2 / (n - 1))); }
  double ci95() const { return n > 0 ? 1.96 * sd() / std::sqrt(n) : 0; }
};

// ---- duplicate match for small games (bp aivat) -------------------------------------
// Agent A (play[0]) against B (play[1]); every deal is played twice with
// seats swapped and the sample unit is A's seat-averaged result, as in
// `bp h2h`. Returns per-deal statistics of the plain and AIVAT results and
// of their paired difference.
struct AivatMatch {
  RunStat plain, aivat, diff;
};
template <class Model>
AivatMatch aivat_small_match(const BettingTree& tree, const Model& M, const PolicyFn play[2],
                             const PolicyFn score[2], const bool known[2], bool exact_depth, int64_t deals,
                             uint64_t seed, int lookahead_from = -1, bool lookahead_obs_only = false) {
  // av[k]: A sits in position k
  Aivat<Model> a0(tree, M, score[0], score[1], known[0], known[1], exact_depth, lookahead_from, lookahead_obs_only);
  Aivat<Model> a1(tree, M, score[1], score[0], known[1], known[0], exact_depth, lookahead_from, lookahead_obs_only);
  const Aivat<Model>* av[2] = {&a0, &a1};
  auto sc = a0.scratch();
  Rng rng(seed), crng(seed ^ 0xC0FFEEULL);
  AivatMatch out;
  std::vector<uint32_t> path;
  for (int64_t i = 0; i < deals; i++) {
    typename Model::State full = M.sample_full(rng);
    double dp = 0, da = 0;
    for (int seat = 0; seat < 2; seat++) {
      path.assign(1, 0);
      uint32_t ni = 0;
      while (tree.nodes[ni].type == DECISION) {
        const Node& n = tree.nodes[ni];
        int bk[2];
        M.buckets(M.prefix(full, n.street), n.street, bk);
        double pr[MAX_ACTIONS];
        (n.player == seat ? play[0] : play[1])(ni, bk[n.player], pr);
        ni = n.child + sample_action(pr, n.nact, rng.uniform());
        path.push_back(ni);
      }
      auto t = av[seat]->score(full, path, seat, crng, sc);
      dp += 0.5 * t.plain;
      da += 0.5 * t.total();
    }
    out.plain.add(dp);
    out.aivat.add(da);
    out.diff.add(da - dp);
  }
  return out;
}

}  // namespace bp
