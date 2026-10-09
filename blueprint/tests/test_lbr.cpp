// ============================================================
// test_lbr.cpp: tests for Local Best Response (src/lbr.h), `make test`.
//
// Oracles:
//   * Kuhn and Leduc: ExactEval's exact best response. LBR is one legal
//     strategy, so its exact expected value against any fixed target can
//     never exceed the best response value, seat by seat. Against a target
//     that always folds to a bet, the greedy one-step lookahead is already a
//     best response, so the two must be equal.
//   * Sampled play must agree with LBR's exact value (both estimators).
//   * Hold'em equity: brute force with the 7-card evaluator, and exact
//     preflop enumeration over all 1,712,304 boards for one matchup.
//   * Hold'em vs always-fold: LBR raises every small blind and wins the big
//     blind, and wins the small blind as big blind, so exactly 75 chips per
//     hand (750 mbb/hand), the always-fold row of the LBR literature.
// ============================================================
#include <algorithm>
#include <cmath>

#include "lbr.h"
#include "mccfr.h"

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

// ---- small games ---------------------------------------------------------------------

struct Small {
  BettingTree tree;
  std::vector<WeightedDeal> wdeals;   // for ExactEval (buckets only)
  std::vector<Deal> deals;            // same deals with cards, for LBR
  double prob = 0;
};

static Small make_kuhn() {
  Small s;
  int b[4] = {3, 1, 1, 1};
  s.tree.build(kuhn_config(), b);
  s.wdeals = KuhnSampler::enumerate();
  for (int a = 0; a < 3; a++)
    for (int c = 0; c < 3; c++)
      if (a != c) s.deals.push_back(KuhnLbrGame::deal(a, c));
  s.prob = 1.0 / 6.0;
  return s;
}

static Small make_leduc() {
  Small s;
  int b[4] = {3, 9, 1, 1};
  s.tree.build(leduc_config(), b);
  s.wdeals = LeducSampler::enumerate();
  for (int a = 0; a < 6; a++)
    for (int c = 0; c < 6; c++)
      for (int p = 0; p < 6; p++)
        if (a != c && a != p && c != p) s.deals.push_back(LeducLbrGame::deal(a, c, p));
  s.prob = 1.0 / 120.0;
  return s;
}

template <class G>
static double lbr_exact_value(const Small& s, const std::vector<float>& pol, const G& g, int seat,
                              const LbrConfig& cfg) {
  Lbr<G> lbr(s.tree, pol, g, cfg);
  Rng rng(1);
  double v = 0;
  for (const Deal& d : s.deals) v += s.prob * lbr.exact(d, seat, rng);
  return v;
}

template <class Sampler>
static std::vector<float> trained_policy(const BettingTree& tree, int64_t iters, uint64_t seed) {
  McfrConfig m;
  m.threads = 1;
  m.seed = seed;
  m.regret_scale = 10000;
  Trainer<Sampler> tr(tree, Sampler{}, m);
  tr.run(iters, 1e9, iters, nullptr);
  std::vector<float> pol(tree.num_slots, 0.f);
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    for (int b = 0; b < tree.buckets[n.street]; b++) {
      uint64_t base = n.slot + uint64_t(b) * n.nact;
      double p[MAX_ACTIONS];
      tr.average(base, n.nact, p);
      for (int a = 0; a < n.nact; a++) pol[base + a] = float(p[a]);
    }
  }
  return pol;
}

static StrategyFn as_fn(const std::vector<float>& pol) {
  return [&pol](uint64_t b, int n, double* o) {
    for (int a = 0; a < n; a++) o[a] = pol[b + a];
  };
}

// For each target: exact LBR value <= exact BR value, per seat, for every
// action menu; equality against always-fold.
template <class G, class Sampler>
static void check_lbr_vs_br(const char* game, const Small& s, const G& g) {
  std::vector<std::pair<std::string, std::vector<float>>> targets;
  for (const char* nm : {"fold", "checkcall", "maniac", "random"}) {
    std::vector<float> p;
    fixed_policy(s.tree, nm, p);
    targets.push_back({nm, p});
  }
  targets.push_back({"mccfr-2k", trained_policy<Sampler>(s.tree, 2000, 3)});
  targets.push_back({"mccfr-200k", trained_policy<Sampler>(s.tree, 200000, 5)});
  ExactEval ev(s.tree, s.wdeals);
  for (auto& [name, pol] : targets) {
    StrategyFn fn = as_fn(pol);
    for (int seat = 0; seat < 2; seat++) {
      double br = ev.best_response_value(seat, fn);
      for (int acts : {LBR_FC, LBR_FCPA})
        for (int from = 0; from < s.tree.cfg.nstreets; from++) {
          LbrConfig cfg;
          cfg.actions = acts;
          cfg.active_from = from;
          double lv = lbr_exact_value(s, pol, g, seat, cfg);
          std::printf("  %s target=%-10s seat %d  BR %+.6f  LBR(%s, rounds %d-%d) %+.6f\n", game, name.c_str(),
                      seat, br, lbr_actions_name(acts), from + 1, s.tree.cfg.nstreets, lv);
          CHECK(lv <= br + 1e-9);
          if (name == "fold" && acts == LBR_FCPA && from == 0) CHECK_NEAR(lv, br, 1e-12);
        }
    }
  }
}

static void test_kuhn_lbr_vs_br() {
  Small s = make_kuhn();
  check_lbr_vs_br<KuhnLbrGame, KuhnSampler>("kuhn ", s, KuhnLbrGame{});
}

static void test_leduc_lbr_vs_br() {
  Small s = make_leduc();
  check_lbr_vs_br<LeducLbrGame, LeducSampler>("leduc", s, LeducLbrGame{});
}

// Always-fold in Leduc: LBR (either seat) bets and the target folds, +1 ante.
static void test_leduc_fold_value() {
  Small s = make_leduc();
  std::vector<float> p;
  fixed_policy(s.tree, "fold", p);
  for (int seat = 0; seat < 2; seat++) CHECK_NEAR(lbr_exact_value(s, p, LeducLbrGame{}, seat, LbrConfig{}), 1.0, 1e-12);
}

// Sampled play converges to the exact value, for the realized-chips and the
// imaginary-observation estimators, and the latter has no larger variance.
static void test_leduc_sampled_matches_exact() {
  Small s = make_leduc();
  std::vector<float> pol = trained_policy<LeducSampler>(s.tree, 20000, 9);
  LeducLbrGame g;
  LbrConfig cfg;
  Lbr<LeducLbrGame> lbr(s.tree, pol, g, cfg);
  for (int seat = 0; seat < 2; seat++) {
    double exact = lbr_exact_value(s, pol, g, seat, cfg);
    Rng rng(77 + seat);
    Lbr<LeducLbrGame>::Ctx ctx;
    const int N = 400000;
    double sc = 0, qc = 0, si = 0, qi = 0;
    for (int i = 0; i < N; i++) {
      const Deal& d = s.deals[rng.below(uint32_t(s.deals.size()))];
      auto r = lbr.play(ctx, d, seat, rng);
      sc += r.chips, qc += r.chips * r.chips, si += r.io, qi += r.io * r.io;
    }
    double mc = sc / N, mi = si / N;
    double sdc = std::sqrt(qc / N - mc * mc), sdi = std::sqrt(qi / N - mi * mi);
    std::printf("  leduc seat %d: exact %+.5f  sampled chips %+.5f (sd %.3f)  io %+.5f (sd %.3f)\n", seat, exact, mc,
                sdc, mi, sdi);
    CHECK(std::fabs(mc - exact) <= 4 * sdc / std::sqrt(double(N)));
    CHECK(std::fabs(mi - exact) <= 4 * sdi / std::sqrt(double(N)));
    CHECK(sdi <= sdc + 1e-12);
  }
}

// ---- hold'em ---------------------------------------------------------------------------

static Deal holdem_deal(const char* h0a, const char* h0b, const char* h1a, const char* h1b,
                        const char* b0, const char* b1, const char* b2, const char* b3, const char* b4) {
  Deal d{};
  const char* cs[9] = {h0a, h0b, h1a, h1b, b0, b1, b2, b3, b4};
  int c[9];
  for (int i = 0; i < 9; i++) c[i] = parse_card(cs[i]);
  for (int i = 0; i < 2; i++) d.hole[0][i] = int8_t(c[i]), d.hole[1][i] = int8_t(c[2 + i]);
  for (int i = 0; i < 5; i++) d.board[i] = int8_t(c[4 + i]);
  return d;
}

static double brute_equity(const int me[2], const int op[2], const int* board, int k) {
  // enumerate every completion of the board from the cards not in use
  uint64_t dead = (1ull << me[0]) | (1ull << me[1]) | (1ull << op[0]) | (1ull << op[1]);
  for (int i = 0; i < k; i++) dead |= 1ull << board[i];
  std::vector<int> deck;
  for (int c = 0; c < 52; c++)
    if (!((dead >> c) & 1)) deck.push_back(c);
  double w = 0;
  long n = 0;
  int b[5];
  for (int i = 0; i < k; i++) b[i] = board[i];
  std::vector<int> idx(5 - k);
  std::function<void(int, int)> rec = [&](int pos, int start) {
    if (pos == 5 - k) {
      for (int i = 0; i < 5 - k; i++) b[k + i] = deck[idx[i]];
      int s0[7] = {me[0], me[1], b[0], b[1], b[2], b[3], b[4]};
      int s1[7] = {op[0], op[1], b[0], b[1], b[2], b[3], b[4]};
      int v0 = eval_n(s0, 7), v1 = eval_n(s1, 7);
      w += v0 > v1 ? 1.0 : v0 == v1 ? 0.5 : 0.0;
      n++;
      return;
    }
    for (int i = start; i < int(deck.size()); i++) {
      idx[pos] = i;
      rec(pos + 1, i + 1);
    }
  };
  rec(0, 0);
  return w / double(n);
}

static void test_holdem_equity_brute_force() {
  HoldemLbrGame g;
  Rng rng(5);
  std::vector<double> eq(NUM_COMBOS);
  const ComboTable& C = combos();
  for (int trial = 0; trial < 6; trial++) {
    Deal d;
    holdem_lbr_deal(rng, d);
    int me[2] = {d.hole[0][0], d.hole[0][1]};
    int board[5];
    for (int i = 0; i < 5; i++) board[i] = d.board[i];
    for (int k : {5, 4, 3}) {
      g.equity_k(d, 0, k, rng, 0, eq.data());
      uint64_t dead = (1ull << me[0]) | (1ull << me[1]);
      for (int i = 0; i < k; i++) dead |= 1ull << board[i];
      int checked = 0;
      for (int h = 0; h < NUM_COMBOS; h++) {
        bool live = !((dead >> C.hi[h]) & 1) && !((dead >> C.lo[h]) & 1);
        if (!live) {
          CHECK(eq[h] == 0.0);
          continue;
        }
        // all combos on the river and turn, a spread of combos on the flop
        if (k == 3 && (h % 97) != 0) continue;
        int op[2] = {C.hi[h], C.lo[h]};
        CHECK_NEAR(eq[h], brute_equity(me, op, board, k), 1e-12);
        checked++;
      }
      CHECK(checked > 0);
    }
  }
  // Preflop Monte Carlo vs exact enumeration for one matchup (AhAs vs KdKc),
  // and every combo's estimate stays in [0, 1].
  Deal d = holdem_deal("Ah", "As", "Kd", "Kc", "2c", "3c", "4c", "5c", "6c");
  int me[2] = {parse_card("Ah"), parse_card("As")}, op[2] = {parse_card("Kd"), parse_card("Kc")};
  double exact = brute_equity(me, op, nullptr, 0);
  const int S = 8000;
  g.equity_k(d, 0, 0, rng, S, eq.data());
  double est = eq[combo_index(op[0], op[1])];
  std::printf("  AhAs vs KdKc preflop: exact %.5f, Monte Carlo (%d boards) %.5f\n", exact, S, est);
  CHECK(std::fabs(est - exact) <= 4 * std::sqrt(exact * (1 - exact) / S));
  for (int h = 0; h < NUM_COMBOS; h++) CHECK(eq[h] >= 0.0 && eq[h] <= 1.0);
}

// Every no-limit preset: fcpa picks only fold / check-call / pot / all-in.
static void test_holdem_menus() {
  int b[4] = {169, 1, 1, 1};
  for (const char* preset : {"tiny", "small", "medium"}) {
    BettingTree tree;
    tree.build(holdem_config(preset), b);
    std::vector<float> pol;
    fixed_policy(tree, "random", pol);
    HoldemLbrGame g;
    for (int acts : {LBR_FC, LBR_FCPA, LBR_TREE}) {
      LbrConfig cfg;
      cfg.actions = acts;
      Lbr<HoldemLbrGame> lbr(tree, pol, g, cfg);
      size_t pots = 0;
      for (const Node& n : tree.nodes) {
        if (n.type != DECISION) continue;
        int passive = 0;
        for (int a = 0; a < n.nact; a++) {
          const Node& c = tree.nodes[n.child + a];
          bool in = lbr.in_menu(c);
          if (c.act_kind == ACT_CHECK || c.act_kind == ACT_CALL) passive += in;
          if (c.act_kind == ACT_FOLD) CHECK(in);
          if (acts == LBR_FC) CHECK(!in || c.act_kind <= ACT_CALL);
          if (acts == LBR_FCPA && in && c.act_kind >= ACT_BET && c.act_kind != ACT_ALLIN) {
            CHECK(c.frac_milli == 1000);
            pots++;
          }
          if (acts == LBR_TREE) CHECK(in);
        }
        CHECK(passive == 1);
      }
      if (acts == LBR_FCPA && std::string(preset) != "tiny") CHECK(pots > 0);
    }
  }
}

// Always-fold target: exactly +100 chips as small blind (pot raise, target
// folds) and +50 as big blind (target folds the small blind), every hand.
static void test_holdem_vs_fold() {
  int b[4] = {169, 1, 1, 1};
  BettingTree tree;
  tree.build(holdem_config("small"), b);
  std::vector<float> pol;
  fixed_policy(tree, "fold", pol);
  HoldemLbrGame g;
  g.pre_samples = 200;
  LbrConfig cfg;
  cfg.actions = LBR_FCPA;
  LbrMatch m = run_lbr_holdem(tree, pol, g, cfg, 300, 2, 11, 1e9);
  std::printf("  vs always-fold: %+.3f chips/hand (%+.1f mbb/hand), SB %+.1f, BB %+.1f, %lld deals\n",
              m.mean_chips, m.mean_chips * 10, m.seat_mean[0], m.seat_mean[1], (long long)m.deals);
  CHECK(m.deals == 300);
  CHECK(m.mean_chips == 75.0);
  CHECK(m.ci_chips == 0.0);
  CHECK(m.seat_mean[0] == 100.0 && m.seat_mean[1] == 50.0);
  CHECK(m.mean_io == 75.0);
}

// fc against check/call: the target never bets, LBR never folds a hand with
// equity >= 1/4 for one small blind, so both seats of each deal check or
// call down the same pot and the duplicate pair sums to exactly zero.
static void test_holdem_fc_vs_checkcall() {
  int b[4] = {169, 1, 1, 1};
  BettingTree tree;
  tree.build(holdem_config("small"), b);
  std::vector<float> pol;
  fixed_policy(tree, "checkcall", pol);
  HoldemLbrGame g;
  g.pre_samples = 400;
  LbrConfig cfg;
  cfg.actions = LBR_FC;
  LbrMatch m = run_lbr_holdem(tree, pol, g, cfg, 60, 2, 4, 1e9);
  CHECK(m.deals == 60);
  CHECK(m.mean_chips == 0.0 && m.ci_chips == 0.0);
  CHECK(m.stats.folds == 0 && m.stats.bets == 0 && m.stats.allins == 0);
}

// Range updates: a target that raises pot preflop only with aces (and folds
// everything else). Holding kings in the big blind facing that raise, LBR
// must fold; facing the same raise from a target that raises every hand,
// kings must continue.
static void test_holdem_range_update() {
  int b[4] = {169, 1, 1, 1};
  BettingTree tree;
  tree.build(holdem_config("small"), b);
  HoldemLbrGame g;  // no abstraction: postflop buckets are 0 (1-bucket streets)
  g.pre_samples = 3000;
  const Node& root = tree.nodes[0];
  int pot_raise = -1, fold = -1;
  for (int a = 0; a < root.nact; a++) {
    const Node& c = tree.nodes[root.child + a];
    if (c.act_kind == ACT_RAISE && c.frac_milli == 1000) pot_raise = a;
    if (c.act_kind == ACT_FOLD) fold = a;
  }
  CHECK(pot_raise >= 0 && fold >= 0);
  int aces = 12 * 13 + 12;
  for (int only_aces = 1; only_aces >= 0; only_aces--) {
    std::vector<float> pol;
    fixed_policy(tree, "checkcall", pol);
    for (int cls = 0; cls < 169; cls++)
      for (int a = 0; a < root.nact; a++)
        pol[root.slot + uint64_t(cls) * root.nact + a] =
            a == ((!only_aces || cls == aces) ? pot_raise : fold) ? 1.f : 0.f;
    LbrConfig cfg;
    Lbr<HoldemLbrGame> lbr(tree, pol, g, cfg);
    Deal d = holdem_deal("Ad", "Ac", "Kh", "Ks", "2c", "7d", "9h", "Js", "3s");  // target AdAc in seat 0
    d.winner = 0;
    Rng rng(3);
    Lbr<HoldemLbrGame>::Ctx ctx;
    auto r = lbr.play(ctx, d, 1, rng);
    std::printf("  KK in BB vs %s: LBR result %+.0f chips, folds %llu\n", only_aces ? "aces-only raise" : "any-hand raise",
                r.chips, (unsigned long long)ctx.stats.folds);
    if (only_aces) CHECK(ctx.stats.folds == 1 && r.chips == -100.0);
    else CHECK(ctx.stats.folds == 0);
  }
}

int main() {
  struct T {
    const char* name;
    void (*fn)();
  } tests[] = {
      {"LBR <= exact BR (Kuhn)", test_kuhn_lbr_vs_br},
      {"LBR <= exact BR (Leduc)", test_leduc_lbr_vs_br},
      {"LBR vs always-fold (Leduc)", test_leduc_fold_value},
      {"LBR sampled == exact (Leduc)", test_leduc_sampled_matches_exact},
      {"hold'em equity vs brute force", test_holdem_equity_brute_force},
      {"hold'em action menus", test_holdem_menus},
      {"hold'em LBR vs always-fold", test_holdem_vs_fold},
      {"hold'em fc vs check/call is zero", test_holdem_fc_vs_checkcall},
      {"hold'em range update", test_holdem_range_update},
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
