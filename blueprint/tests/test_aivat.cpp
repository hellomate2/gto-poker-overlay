// ============================================================
// test_aivat.cpp: tests for the AIVAT estimator (`make test-aivat`).
//
// Oracles:
//   * exact enumeration over every deal and action path of Kuhn and Leduc:
//     the estimator's expectation must equal ExactEval's game value (to
//     floating-point precision) for every choice of known players and value
//     function, and its variance must be exactly zero when both strategies
//     are known and V is the exact value;
//   * hold'em equities: flop equity equals the average of turn equities over
//     every turn card, turn equity the average of river results (brute force),
//     and the preflop class table agrees with an exact enumeration of all
//     1,712,304 boards for one hand pair;
//   * a sampled hold'em run (no card abstraction, 1 postflop bucket) whose
//     mean AIVAT-minus-plain difference must be within 4 standard errors of 0.
// ============================================================
#include <cmath>
#include <cstdio>

#include "aivat.h"
#include "aivat_holdem.h"
#include "games.h"
#include "mccfr.h"
#include "tree.h"

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

// A fixed, arbitrary, fully mixed policy (hash of node and bucket), so the
// tests do not depend on training.
static PolicyFn hashed_policy(const BettingTree& tree, uint64_t salt) {
  return [&tree, salt](uint32_t ni, int b, double* out) {
    const Node& n = tree.nodes[ni];
    double s = 0;
    for (int a = 0; a < n.nact; a++) {
      uint64_t x = salt ^ (uint64_t(ni) << 20) ^ (uint64_t(b) << 8) ^ uint64_t(a);
      out[a] = 0.05 + double(splitmix64(x) >> 11) * (1.0 / 9007199254740992.0);
      s += out[a];
    }
    for (int a = 0; a < n.nact; a++) out[a] /= s;
  };
}
static PolicyFn uniform_policy(const BettingTree& tree) {
  return [&tree](uint32_t ni, int, double* out) {
    int na = tree.nodes[ni].nact;
    for (int a = 0; a < na; a++) out[a] = 1.0 / na;
  };
}
template <class Sampler>
static std::vector<float> trained_policy(const BettingTree& tree, int64_t iters, uint64_t seed) {
  McfrConfig m;
  m.regret_scale = 10000;
  m.seed = seed;
  Trainer<Sampler> tr(tree, Sampler{}, m);
  tr.run(iters, 1e9, iters, nullptr);
  std::vector<float> pol(tree.num_slots);
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    for (int b = 0; b < tree.buckets[n.street]; b++) {
      double p[MAX_ACTIONS];
      tr.average(n.slot + uint64_t(b) * n.nact, n.nact, p);
      for (int a = 0; a < n.nact; a++) pol[n.slot + uint64_t(b) * n.nact + a] = float(p[a]);
    }
  }
  return pol;
}
static PolicyFn table_policy(const BettingTree& tree, const std::vector<float>& pol) {
  return [&tree, &pol](uint32_t ni, int b, double* out) {
    const Node& n = tree.nodes[ni];
    for (int a = 0; a < n.nact; a++) out[a] = pol[n.slot + uint64_t(b) * n.nact + a];
  };
}

// Exact game value for position p when play[0] sits in position 0.
template <class Sampler>
static double exact_value(const BettingTree& tree, const PolicyFn play[2], int p) {
  ExactEval ev(tree, Sampler::enumerate());
  // ExactEval looks strategies up by slot base; map back to (node, bucket).
  std::vector<uint32_t> node_of(tree.num_slots + 1, 0);
  for (uint32_t i = 0; i < tree.nodes.size(); i++)
    if (tree.nodes[i].type == DECISION)
      for (int b = 0; b < tree.buckets[tree.nodes[i].street]; b++)
        node_of[tree.nodes[i].slot + uint64_t(b) * tree.nodes[i].nact] = i;
  StrategyFn s = [&](uint64_t base, int na, double* out) {
    uint32_t ni = node_of[base];
    const Node& n = tree.nodes[ni];
    int b = int((base - n.slot) / n.nact);
    double pr[MAX_ACTIONS];
    play[n.player](ni, b, pr);
    effective_probs(pr, na, out);
  };
  double v0 = ev.value_p0(s);
  return p == 0 ? v0 : -v0;
}

template <class Model, class Sampler>
static void exact_suite(const char* game, const BettingTree& tree, const Model& M, const PolicyFn play[2],
                        bool print_sd) {
  for (int p = 0; p < 2; p++) {
    double ref = exact_value<Sampler>(tree, play, p);
    for (int kn = 0; kn < 4; kn++)
      for (int ex = 0; ex < 3; ex++) {
        // ex 0: street V; 1: exact V; 2: lookahead on the observed path only
        bool k0 = kn & 1, k1 = (kn >> 1) & 1;
        // An unknown player's V model is the other player's strategy.
        PolicyFn s0 = k0 ? play[0] : play[1], s1 = k1 ? play[1] : play[0];
        Aivat<Model> av(tree, M, s0, s1, k0, k1, ex == 1, ex == 2 ? 1 : -1, ex == 2);
        AivatMoments m = aivat_exact_moments(av, play, p);
        CHECK_NEAR(m.mean_plain, ref, 1e-9);
        CHECK_NEAR(m.mean_est, ref, 1e-9);
        if (std::fabs(m.mean_est - ref) > 1e-9 || std::fabs(m.mean_plain - ref) > 1e-9)
          std::printf("    %s p%d kn%d ex%d: plain-ref %.3e est-ref %.3e\n", game, p, kn, ex, m.mean_plain - ref,
                      m.mean_est - ref);
        // every path scores the game value
        if (k0 && k1 && ex == 1) CHECK(m.max_est - m.min_est < 1e-9);
        if (k0 && k1) CHECK(m.var_est < m.var_plain);
        if (print_sd && p == 0)
          std::printf("  %s p0 known=%s V=%s: mean %.6f (exact %.6f), SD plain %.4f -> aivat %.6f (%.4f%% removed)\n",
                      game, kn == 3 ? "both" : kn == 1 ? "p0" : kn == 2 ? "p1" : "none", ex == 1 ? "exact " : ex == 2 ? "obs-la" : "street",
                      m.mean_est, ref, std::sqrt(m.var_plain), std::sqrt(m.var_est),
                      100.0 * (1.0 - std::sqrt(m.var_est) / std::sqrt(m.var_plain)));
      }
  }
}

static void test_kuhn_exact() {
  BettingTree tree;
  int b[4] = {3, 1, 1, 1};
  tree.build(kuhn_config(), b);
  KuhnModel M;
  PolicyFn h1 = hashed_policy(tree, 11), h2 = hashed_policy(tree, 12);
  PolicyFn play[2] = {h1, h2};
  exact_suite<KuhnModel, KuhnSampler>("kuhn", tree, M, play, true);
}

static void test_leduc_exact() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  LeducModel M;
  // fixed mixed policies
  PolicyFn h1 = hashed_policy(tree, 21), h2 = hashed_policy(tree, 22);
  PolicyFn play[2] = {h1, h2};
  exact_suite<LeducModel, LeducSampler>("leduc hashed", tree, M, play, false);
  // trained vs uniform: a strategy with zero-probability actions
  std::vector<float> tp = trained_policy<LeducSampler>(tree, 100000, 3);
  PolicyFn t = table_policy(tree, tp), u = uniform_policy(tree);
  PolicyFn play2[2] = {t, u};
  exact_suite<LeducModel, LeducSampler>("leduc trained-vs-uniform", tree, M, play2, true);
  PolicyFn play3[2] = {t, t};
  exact_suite<LeducModel, LeducSampler>("leduc self-play", tree, M, play3, true);
}

// Sampled Leduc: the Monte Carlo estimate of the AIVAT mean must agree with
// the exact value, and with both strategies known and exact V every sample
// equals the game value.
static void test_leduc_sampled() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  LeducModel M;
  std::vector<float> tp = trained_policy<LeducSampler>(tree, 100000, 3);
  PolicyFn t = table_policy(tree, tp), u = uniform_policy(tree);
  PolicyFn play[2] = {t, u};
  double ref = exact_value<LeducSampler>(tree, play, 0);
  for (int ex = 0; ex < 2; ex++) {
    Aivat<LeducModel> av(tree, M, t, u, true, true, ex == 1);
    auto sc = av.scratch();
    Rng rng(5), crng(6);
    RunStat plain, est;
    std::vector<uint32_t> path;
    for (int h = 0; h < 200000; h++) {
      int c[3];
      uint32_t used = 0;
      for (int i = 0; i < 3; i++) {
        do c[i] = int(rng.below(6)); while (used >> c[i] & 1);
        used |= 1u << c[i];
      }
      LeducModel::State full{{c[0], c[1]}, c[2]};
      path.assign(1, 0);
      uint32_t ni = 0;
      while (tree.nodes[ni].type == DECISION) {
        const Node& n = tree.nodes[ni];
        int bk[2];
        M.buckets(M.prefix(full, n.street), n.street, bk);
        double pr[MAX_ACTIONS];
        play[n.player](ni, bk[n.player], pr);
        ni = n.child + sample_action(pr, n.nact, rng.uniform());
        path.push_back(ni);
      }
      auto r = av.score(full, path, 0, crng, sc);
      plain.add(r.plain);
      est.add(r.total());
    }
    std::printf("  leduc sampled 200k, V=%s: plain %.4f +/- %.4f, aivat %.6f +/- %.6f (exact %.6f), "
                "SD %.4f -> %.6f\n",
                ex ? "exact " : "street", plain.mean(), plain.ci95(), est.mean(), est.ci95(), ref, plain.sd(), est.sd());
    CHECK(std::fabs(plain.mean() - ref) < 4 * plain.sd() / std::sqrt(plain.n));
    CHECK(std::fabs(est.mean() - ref) < 4 * est.sd() / std::sqrt(est.n) + 1e-9);
    if (ex == 1) CHECK(est.sd() < 1e-9);
    CHECK(est.sd() < 0.5 * plain.sd());
  }
}

// ---- hold'em ----------------------------------------------------------------------

static const HoldemModel& model_noabs() {
  static HoldemModel M(nullptr, 8, 300, 4);
  return M;
}

static void test_holdem_equity() {
  const HoldemModel& M = model_noabs();
  // deal weights: a probability distribution over class pairs
  double w = 0;
  for (const auto& d : M.deals) w += d.w;
  CHECK_NEAR(w, 1.0, 1e-12);
  CHECK(M.deals.size() == 169u * 169u);  // every class pair is possible
  Rng rng(42);
  for (int trial = 0; trial < 20; trial++) {
    int c[9];
    uint64_t used = 0;
    for (int i = 0; i < 9; i++) {
      do c[i] = int(rng.below(52)); while (used >> c[i] & 1);
      used |= 1ull << c[i];
    }
    HoldemModel::State s{{{c[0], c[1]}, {c[2], c[3]}}, {c[4], c[5], c[6], c[7], c[8]}, 5};
    // river: equity is the showdown result
    int w5 = M.winner(s);
    CHECK_NEAR(M.equity(s, 3, 0), w5 == 0 ? 1.0 : w5 == 2 ? 0.5 : 0.0, 0);
    // turn = mean of river results over every river card
    Rng dummy(1);
    double et = 0;
    M.for_each_board(M.prefix(s, 2), 3, dummy, [&](const HoldemModel::State& t, double wt) {
      int ww = M.winner(t);
      et += wt * (ww == 0 ? 1.0 : ww == 2 ? 0.5 : 0.0);
    });
    CHECK_NEAR(M.equity(s, 2, 0), et, 1e-12);
    // flop = mean of turn equities over every turn card
    double ef = 0;
    M.for_each_board(M.prefix(s, 1), 2, dummy,
                     [&](const HoldemModel::State& t, double wt) { ef += wt * M.equity(t, 2, 0); });
    CHECK_NEAR(M.equity(s, 1, 0), ef, 1e-12);
    for (int st = 0; st < 4; st++) CHECK_NEAR(M.equity(s, st, 0) + M.equity(s, st, 1), 1.0, 1e-6);
  }
  // preflop table vs exact enumeration for AhAd vs KcKs (all C(48,5) boards)
  int h0[2] = {parse_card("Ah"), parse_card("Ad")}, h1[2] = {parse_card("Kc"), parse_card("Ks")};
  const EvalTables& T = eval_tables();
  uint64_t dead = 1ull << h0[0] | 1ull << h0[1] | 1ull << h1[0] | 1ull << h1[1];
  int rem[48], nr = 0;
  for (int x = 0; x < 52; x++)
    if (!(dead >> x & 1)) rem[nr++] = x;
  long s2 = 0, n = 0;
  for (int a = 0; a < nr; a++)
    for (int b = a + 1; b < nr; b++)
      for (int c = b + 1; c < nr; c++)
        for (int d = c + 1; d < nr; d++)
          for (int e = d + 1; e < nr; e++) {
            int bd[5] = {rem[a], rem[b], rem[c], rem[d], rem[e]};
            HandAcc A, B;
            for (int i = 0; i < 5; i++) A.add(bd[i], T), B.add(bd[i], T);
            A.add(h0[0], T), A.add(h0[1], T), B.add(h1[0], T), B.add(h1[1], T);
            int va = eval_acc(A, T), vb = eval_acc(B, T);
            s2 += (va > vb) * 2 + (va == vb);
            n++;
          }
  double exact = double(s2) / (2.0 * n);
  HoldemModel::State s{{{h0[0], h0[1]}, {h1[0], h1[1]}}, {0, 0, 0, 0, 0}, 0};
  double table = M.equity(s, 0, 0);
  std::printf("  AhAd vs KcKs: exact %.5f over %ld boards, class table AA vs KK %.5f\n", exact, n, table);
  CHECK(n == 1712304);
  CHECK_NEAR(table, exact, 0.03);
}

// Sampled hold'em on the tiny tree without a card abstraction: AIVAT minus
// plain must average to zero (paired, 4 standard errors), and lower the SD.
static void test_holdem_unbiased() {
  const HoldemModel& M = model_noabs();
  BettingTree tree;
  int b[4] = {169, 1, 1, 1};
  tree.build(holdem_config("tiny"), b);
  PolicyFn pa = hashed_policy(tree, 31), pb = hashed_policy(tree, 32);
  PolicyFn play[2] = {pa, pb};
  for (int kn = 0; kn < 4; kn++) {
    bool kb = kn & 1, la = kn >= 2;  // la: lookahead from the turn on the observed path
    Aivat<HoldemModel> av(tree, M, pa, kb ? pb : pa, true, kb, false, la ? 2 : -1, la);
    auto sc = av.scratch();
    Rng rng(9), crng(10);
    RunStat plain, est, diff;
    std::vector<uint32_t> path;
    int allins = 0;
    for (int h = 0; h < 20000; h++) {
      int c[9];
      uint64_t used = 0;
      for (int i = 0; i < 9; i++) {
        do c[i] = int(rng.below(52)); while (used >> c[i] & 1);
        used |= 1ull << c[i];
      }
      HoldemModel::State full{{{c[0], c[1]}, {c[2], c[3]}}, {c[4], c[5], c[6], c[7], c[8]}, 5};
      path.assign(1, 0);
      uint32_t ni = 0;
      while (tree.nodes[ni].type == DECISION) {
        const Node& n = tree.nodes[ni];
        int bk[2];
        M.buckets(M.prefix(full, n.street), n.street, bk);
        double pr[MAX_ACTIONS];
        play[n.player](ni, bk[n.player], pr);
        ni = n.child + sample_action(pr, n.nact, rng.uniform());
        path.push_back(ni);
      }
      const Node& z = tree.nodes[ni];
      if (z.type == SHOWDOWN && z.street < 3) allins++;
      auto r = av.score(full, path, 0, crng, sc);
      plain.add(r.plain);
      est.add(r.total());
      diff.add(r.total() - r.plain);
    }
    std::printf("  holdem tiny 20k hands, known=%s%s: plain %.1f +/- %.1f, aivat %.1f +/- %.1f, diff %.1f +/- %.1f "
                "chips, SD %.0f -> %.0f, all-ins before river %d\n",
                kb ? "both" : "p0", la ? ", lookahead" : "", plain.mean(), plain.ci95(), est.mean(), est.ci95(), diff.mean(), diff.ci95(),
                plain.sd(), est.sd(), allins);
    CHECK(std::fabs(diff.mean()) < 4 * diff.sd() / std::sqrt(diff.n));
    CHECK(est.sd() < plain.sd());
    CHECK(allins > 0);
  }
}

int main() {
  struct T {
    const char* name;
    void (*fn)();
  } tests[] = {
      {"aivat kuhn exact", test_kuhn_exact},
      {"aivat leduc exact", test_leduc_exact},
      {"aivat leduc sampled", test_leduc_sampled},
      {"aivat holdem equity", test_holdem_equity},
      {"aivat holdem unbiased", test_holdem_unbiased},
  };
  for (auto& t : tests) {
    int before = g_fail;
    double t0 = now_sec();
    t.fn();
    std::printf("%s %s (%.2fs)\n", g_fail == before ? "ok  " : "FAIL", t.name, now_sec() - t0);
  }
  std::printf("%d checks, %d failures\n", g_checks, g_fail);
  return g_fail ? 1 : 0;
}
