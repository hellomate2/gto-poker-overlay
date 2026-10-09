// ============================================================
// test_rt.cpp: tests for the real-time search code (`make test-rt`).
//
// Oracles: closed-form toy games, brute-force O(n^2) showdown sums, and the
// trainer's ExactEval best response on Leduc hold'em (an independent
// implementation that walks the full game with explicit deals).
// ============================================================
#include <algorithm>
#include <map>

#include "eval.h"
#include "games.h"
#include "mccfr.h"
#include "search.h"
#include "subgame.h"
#include "tree.h"

using namespace bp;
using namespace bp::rt;

static int g_fail = 0, g_checks = 0;
#define CHECK(cond)                                                 \
  do {                                                              \
    g_checks++;                                                     \
    if (!(cond)) {                                                  \
      g_fail++;                                                     \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    }                                                               \
  } while (0)
#define CHECK_NEAR(a, b, tol)                                                                              \
  do {                                                                                                     \
    double _a = double(a), _b = double(b);                                                                 \
    g_checks++;                                                                                            \
    if (!(std::fabs(_a - _b) <= (tol))) {                                                                  \
      g_fail++;                                                                                            \
      std::printf("  FAIL %s:%d: %s = %.9g vs %s = %.9g (tol %g)\n", __FILE__, __LINE__, #a, _a, #b, _b, \
                  double(tol));                                                                            \
    }                                                                                                      \
  } while (0)

// ---- toy river game: polarized bettor vs bluff catcher --------------------------------
// P0 holds the nuts or air (equal weight), P1 a bluff catcher. P0 checks
// (showdown) or bets s * pot; P1 folds or calls. Equilibrium: P0 bets every
// nut hand, bluffs so that bluffs are s / (1 + 2s) of its betting range, and
// P1 calls with probability 1 / (1 + s).
static void toy_polar(double s, SolverConfig sc, int iters) {
  Game g;
  g.cards_per_hand = 0;
  g.full_board = 0;
  g.pot0 = 1.0;
  auto mk = [](int str) {
    Hand h;
    h.c[0] = str;  // strength tag; no cards
    h.nc = 0;
    return h;
  };
  g.hands[0] = {mk(2), mk(0)};
  g.w[0] = {0.5, 0.5};
  g.hands[1] = {mk(1)};
  g.w[1] = {1.0};
  g.strength = [](const Hand& h, const std::vector<int>&) { return int32_t(h.c[0]); };
  int b = g.add_board({});
  SNode root;
  root.board = b;
  root.pot = 1;
  add_node(g, root);
  SNode x;  // check -> showdown
  x.type = S_SHOW, x.board = b, x.pot = 1, x.parent = 0, x.label = "X";
  SNode bet;
  bet.type = S_DEC, bet.player = 1, bet.board = b, bet.c[0] = s, bet.pot = 1 + s, bet.parent = 0, bet.label = "B";
  g.nodes[0].first = 1;
  g.nodes[0].nact = 2;
  add_node(g, x);
  int bi = add_node(g, bet);
  SNode f, c;
  f.type = S_FOLD, f.player = 1, f.board = b, f.c[0] = s, f.pot = 1 + s, f.parent = bi, f.label = "F";
  c.type = S_SHOW, c.board = b, c.c[0] = s, c.c[1] = s, c.pot = 1 + 2 * s, c.parent = bi, c.label = "C";
  g.nodes[bi].first = int(g.nodes.size());
  g.nodes[bi].nact = 2;
  add_node(g, f);
  add_node(g, c);
  g.finalize();
  Solver S(g, sc);
  for (int i = 0; i < iters; i++) S.iterate();
  double pn[2], pa[2], pc[2];
  S.average(0, 0, pn);
  S.average(0, 1, pa);
  S.average(bi, 0, pc);
  double bluff_share = pa[1] / (pa[1] + pn[1]);
  std::printf("  toy s=%.2f %s: nut bet %.5f, bluff share %.5f (closed form %.5f), call %.5f (closed form %.5f), "
              "exploitability %.2e pot\n",
              s, sc.algo == SolverConfig::DCFR ? "DCFR" : "CFR+", pn[1], bluff_share, s / (1 + 2 * s), pc[1],
              1 / (1 + s), S.exploitability());
  CHECK_NEAR(pn[1], 1.0, 2e-3);
  CHECK_NEAR(bluff_share, s / (1 + 2 * s), 2e-3);
  CHECK_NEAR(pc[1], 1 / (1 + s), 2e-3);
  CHECK(S.exploitability() < 1e-3);
}

static void test_toy_closed_form() {
  for (double s : {0.5, 1.0, 2.0}) {
    toy_polar(s, SolverConfig{}, 3000);
    SolverConfig cp;
    cp.algo = SolverConfig::CFRPLUS;
    toy_polar(s, cp, 3000);
  }
}

// ---- showdown evaluation against brute force ----------------------------------------
static void random_ranges(Game& g, Rng& rng, uint64_t dead, int n0, int n1) {
  for (int p = 0; p < 2; p++) {
    int n = p == 0 ? n0 : n1;
    while (int(g.hands[p].size()) < n) {
      int a = int(rng.below(52)), b = int(rng.below(52));
      if (a == b || (dead >> a & 1) || (dead >> b & 1)) continue;
      uint64_t m = (1ull << a) | (1ull << b);
      bool dup = false;
      for (auto& h : g.hands[p]) dup |= h.mask == m;
      if (dup) continue;
      Hand h;
      h.c[0] = a, h.c[1] = b, h.nc = 2, h.mask = m;
      g.hands[p].push_back(h);
      g.w[p].push_back(0.1 + rng.uniform());
    }
  }
}

static double brute_value(const Game& g, const std::vector<int>& board, double pot, double c0) {
  // E[u0] over compatible pairs and all completions of the board.
  uint64_t bm = 0;
  for (int c : board) bm |= 1ull << c;
  std::vector<std::vector<int>> runs;
  if (board.size() == 5) runs.push_back({});
  else
    for (int x = 0; x < 52; x++)
      if (!(bm >> x & 1)) runs.push_back({x});
  double num = 0, den = 0;
  for (int i = 0; i < g.n(0); i++)
    for (int j = 0; j < g.n(1); j++) {
      const Hand &a = g.hands[0][i], &b = g.hands[1][j];
      if (a.mask & b.mask) continue;
      double s = 0, k = 0;
      for (auto& r : runs) {
        if (!r.empty() && ((a.mask | b.mask) >> r[0] & 1)) continue;
        std::vector<int> full = board;
        for (int x : r) full.push_back(x);
        int32_t sa = holdem_strength(a, full), sb = holdem_strength(b, full);
        s += sa > sb ? 1 : sa < sb ? 0 : 0.5;
        k++;
      }
      double w = g.w[0][i] * g.w[1][j];
      num += w * (pot * s / k - c0);
      den += w;
    }
  return num / den;
}

static void test_showdown_brute_force() {
  Rng rng(11);
  for (int trial = 0; trial < 3; trial++) {
    for (int nb : {5, 4}) {
      std::vector<int> board;
      uint64_t bm = 0;
      while (int(board.size()) < nb) {
        int c = int(rng.below(52));
        if (bm >> c & 1) continue;
        bm |= 1ull << c;
        board.push_back(c);
      }
      Game g;
      random_ranges(g, rng, bm, 60, 70);
      // Add an identical combo to both sides to exercise the same-hand term.
      g.hands[1].push_back(g.hands[0][0]);
      g.w[1].push_back(0.7);
      g.strength = holdem_strength;
      g.pot0 = 10;
      int b = g.add_board(board);
      SNode r;
      r.type = S_SHOW, r.board = b, r.c[0] = r.c[1] = 3, r.pot = 16;
      add_node(g, r);
      g.finalize();
      Solver S(g, SolverConfig{});
      double v = S.value(0, false), v1 = S.value(1, false);
      double ref = brute_value(g, board, 16, 3);
      CHECK_NEAR(v, ref, 1e-9);
      CHECK_NEAR(v + v1, 10.0, 1e-9);  // constant-sum
      if (nb == 4) {
        // Same showdown through an explicit chance node with river children.
        Game h = g;
        h.nodes.clear();
        h.boards.clear();
        int b4 = h.add_board(board);
        SNode ch;
        ch.type = S_CHANCE, ch.board = b4, ch.c[0] = ch.c[1] = 3, ch.pot = 16;
        add_node(h, ch);
        std::vector<int> cards;
        for (int x = 0; x < 52; x++)
          if (!(bm >> x & 1)) cards.push_back(x);
        h.nodes[0].first = 1;
        h.nodes[0].nact = int(cards.size());
        for (int x : cards) {
          std::vector<int> b5 = board;
          b5.push_back(x);
          SNode s;
          s.type = S_SHOW, s.board = h.add_board(b5), s.c[0] = s.c[1] = 3, s.pot = 16, s.deal = x, s.parent = 0;
          add_node(h, s);
        }
        h.finalize();
        Solver S2(h, SolverConfig{});
        CHECK_NEAR(S2.value(0, false), ref, 1e-9);
        CHECK_NEAR(S2.value(1, false), 10 - ref, 1e-9);
      }
    }
  }
  std::printf("  showdown sweep, equity matrix and chance node match brute force on 3 river + 3 turn spots\n");
}

// ---- Leduc ---------------------------------------------------------------------------
struct Leduc {
  BettingTree tree;
  BpView bv;
  std::vector<double> table;  // policy per slot
  Leduc() {
    int b[4] = {3, 9, 1, 1};
    tree.build(leduc_config(), b);
    bv.tree = &tree;
    bv.policy = [this](uint64_t base, int na, double* out) {
      for (int a = 0; a < na; a++) out[a] = table[base + a];
    };
    bv.bucket = [](const Hand& h, const std::vector<int>& board, int street) {
      return street == 0 ? h.c[0] / 2 : (h.c[0] / 2) * 3 + board[0] / 2;
    };
    bv.strength = [](const Hand& h, const std::vector<int>& board) -> int32_t {
      if (h.mask >> board[0] & 1) return -1;
      int r = h.c[0] / 2, pr = board[0] / 2;
      return r == pr ? 100 + r : r;
    };
    bv.deck = 6;
    bv.cards_per_hand = 1;
    bv.board_len = {0, 1};
    table.assign(tree.num_slots, 0.f);
  }
  void hands(Game& g) const {
    for (int p = 0; p < 2; p++) {
      g.hands[p].clear();
      g.w[p].clear();
      for (int c = 0; c < 6; c++) {
        Hand h;
        h.c[0] = c, h.nc = 1, h.mask = 1ull << c;
        g.hands[p].push_back(h);
        g.w[p].push_back(1.0);
      }
    }
  }
  StrategyFn fn() const {
    return [this](uint64_t base, int na, double* out) {
      for (int a = 0; a < na; a++) out[a] = table[base + a];
    };
  }
  // Overwrite table entries with the solver's averages at every decision
  // node of g (each bucket takes the first hand that maps to it).
  void absorb(const Game& g, const Solver& S, std::vector<char>* filled = nullptr) {
    std::vector<char> done(tree.num_slots, 0);
    for (size_t x = 0; x < g.nodes.size(); x++) {
      const SNode& nd = g.nodes[x];
      if (nd.type != S_DEC) continue;
      const Node& bn = tree.nodes[nd.bp];
      // board in deal order: Leduc has at most one card, so sorted == dealt
      const std::vector<int>& board = g.boards[nd.board].cards;
      for (int h = 0; h < g.n(nd.player); h++) {
        const Hand& hd = g.hands[nd.player][h];
        uint64_t bm = 0;
        for (int c : board) bm |= 1ull << c;
        if (hd.mask & bm) continue;
        uint64_t base = bn.slot + uint64_t(bv.bucket(hd, board, bn.street)) * bn.nact;
        if (done[base]) continue;
        done[base] = 1;
        if (filled) (*filled)[base] = 1;
        double p[MAX_ACTIONS];
        S.average(int(x), h, p);
        for (int a = 0; a < bn.nact; a++) table[base + a] = p[a];
      }
    }
  }
  // Solver over the full game with this table as an external strategy.
  void external(Solver& S, const Game& g) const {
    S.external = [this, &g](int node, int h, double* out) {
      const SNode& nd = g.nodes[node];
      const Node& bn = tree.nodes[nd.bp];
      const Hand& hd = g.hands[nd.player][h];
      uint64_t bm = 0;
      for (int c : g.boards[nd.board].cards) bm |= 1ull << c;
      if (hd.mask & bm) {
        for (int a = 0; a < bn.nact; a++) out[a] = 1.0 / bn.nact;
        return;
      }
      uint64_t base = bn.slot + uint64_t(bv.bucket(hd, g.boards[nd.board].cards, bn.street)) * bn.nact;
      for (int a = 0; a < bn.nact; a++) out[a] = table[base + a];
    };
  }
};

static void train_leduc_blueprint(Leduc& L, int64_t iters, uint64_t seed) {
  McfrConfig m;
  m.seed = seed;
  m.regret_scale = 10000;
  Trainer<LeducSampler> tr(L.tree, LeducSampler{}, m);
  tr.run(iters, 1e9, iters, nullptr);
  for (const Node& n : L.tree.nodes) {
    if (n.type != DECISION) continue;
    for (int b = 0; b < L.tree.buckets[n.street]; b++) {
      double p[MAX_ACTIONS];
      tr.average(n.slot + uint64_t(b) * n.nact, n.nact, p);
      for (int a = 0; a < n.nact; a++) L.table[n.slot + uint64_t(b) * n.nact + a] = p[a];
    }
  }
}

static Leduc* g_star = nullptr;  // near-equilibrium table, shared by later tests

static void test_leduc_full_game() {
  Leduc L;
  train_leduc_blueprint(L, 20000, 3);
  ExactEval ev(L.tree, LeducSampler::enumerate());
  StrategyFn f = L.fn();
  Game g;
  L.hands(g);
  build_from_blueprint(g, L.bv, 0, {}, false);
  g.finalize();
  // 1) The vector evaluator on an arbitrary (MCCFR) strategy equals ExactEval.
  Solver E(g, SolverConfig{});
  L.external(E, g);
  double br0 = E.value(0, true) - 1, br1 = E.value(1, true) - 1, v0 = E.value(0, false) - 1;
  CHECK_NEAR(br0, ev.best_response_value(0, f), 1e-9);
  CHECK_NEAR(br1, ev.best_response_value(1, f), 1e-9);
  CHECK_NEAR(v0, ev.value_p0(f), 1e-9);
  CHECK_NEAR(E.exploitability(), ev.exploitability(f), 1e-9);
  std::printf("  Leduc, MCCFR 20k-iteration strategy: vector BR0 %.9f vs ExactEval %.9f, BR1 %.9f vs %.9f, "
              "exploitability %.6f\n",
              br0, ev.best_response_value(0, f), br1, ev.best_response_value(1, f), ev.exploitability(f));
  // 2) Solving the whole game as one subgame converges to the Leduc value.
  Solver S(g, SolverConfig{});
  double t0 = now_sec();
  for (int i = 0; i < 2000; i++) S.iterate();
  double dt = now_sec() - t0;
  L.absorb(g, S);
  double e = ev.exploitability(L.fn()), v = ev.value_p0(L.fn());
  std::printf("  Leduc full-game vector DCFR, 2000 iterations in %.2fs: ExactEval exploitability %.2e, value %.6f "
              "(own BR says %.2e)\n",
              dt, e, v, S.exploitability());
  CHECK(e < 1e-3);
  CHECK_NEAR(v, -0.0856, 2e-3);  // Leduc game value for the first player, about -0.0856
  CHECK_NEAR(S.exploitability(), e, 1e-6);
  g_star = new Leduc();
  g_star->table = L.table;
}

// Round-2 subgames re-solved from equilibrium beliefs have the equilibrium's value.
static void test_leduc_subgame_resolve() {
  Leduc& L = *g_star;
  int checked = 0;
  double worst = 0;
  for (uint32_t ni = 0; ni < L.tree.nodes.size(); ni++) {
    const Node& n = L.tree.nodes[ni];
    if (n.type != DECISION || n.street != 1 || L.tree.nodes[n.parent].street != 0) continue;
    for (int pub = 0; pub < 6; pub += 2) {
      Game g;
      L.hands(g);
      std::vector<int> board = {pub};
      for (int p = 0; p < 2; p++) g.w[p] = blueprint_reach(L.bv, g.hands[p], p, ni, board);
      build_from_blueprint(g, L.bv, ni, board, false);
      g.finalize();
      Solver star(g, SolverConfig{});
      L.external(star, g);
      double v_star = star.value(0, false), e_star = star.exploitability();
      Solver S(g, SolverConfig{});
      for (int i = 0; i < 1000; i++) S.iterate();
      double v = S.value(0, false), e = S.exploitability();
      CHECK(e < 1e-3 * g.pot0);
      CHECK(std::fabs(v - v_star) <= 2 * (e + e_star) + 1e-9);
      worst = std::max(worst, std::fabs(v - v_star));
      checked++;
    }
  }
  std::printf("  %d Leduc round-2 subgames re-solved from equilibrium beliefs: max |value - equilibrium value| %.2e\n",
              checked, worst);
  CHECK(checked == 15);
}

// Depth-limited search (M5) on Leduc round 1 with leaves at the round-2 roots.
static double composite_exploitability(Leduc& base, const Game& g, const Solver& S, bool resolve_round2,
                                       double* trunk_value = nullptr) {
  Leduc C;
  C.table = base.table;
  C.absorb(g, S);  // trunk (round 1) from the search
  if (resolve_round2) {
    // Unsafe re-solve of every round-2 subgame from the composite's beliefs.
    Leduc R;
    R.table = C.table;
    for (uint32_t ni = 0; ni < C.tree.nodes.size(); ni++) {
      const Node& n = C.tree.nodes[ni];
      if (n.type != DECISION || n.street != 1 || C.tree.nodes[n.parent].street != 0) continue;
      for (int pub = 0; pub < 6; pub += 2) {
        Game h;
        C.hands(h);
        std::vector<int> board = {pub};
        bool ok = true;
        for (int p = 0; p < 2; p++) {
          h.w[p] = blueprint_reach(C.bv, h.hands[p], p, ni, board);
          double s = 0;
          for (double x : h.w[p]) s += x;
          ok &= s > 0;
        }
        if (!ok) continue;  // unreached subgame: keep the blueprint
        build_from_blueprint(h, C.bv, ni, board, false);
        h.finalize();
        Solver T(h, SolverConfig{});
        for (int i = 0; i < 500; i++) T.iterate();
        R.absorb(h, T);
      }
    }
    C.table = R.table;
  }
  ExactEval ev(C.tree, LeducSampler::enumerate());
  if (trunk_value) *trunk_value = ev.value_p0(C.fn());
  return ev.exploitability(C.fn());
}

static void test_leduc_depth_limited() {
  // (a) k = 1 with the equilibrium as the continuation: the depth-limited
  // game's value equals the full game's value.
  {
    Leduc& L = *g_star;
    Game g;
    L.hands(g);
    std::vector<uint32_t> lv = build_from_blueprint(g, L.bv, 0, {}, true);
    g.finalize();
    build_leaf_values(g, L.bv, lv, {}, 1, 5.0, 0, 1, 1);
    Solver S(g, SolverConfig{});
    for (int i = 0; i < 2000; i++) S.iterate();
    ExactEval ev(L.tree, LeducSampler::enumerate());
    double full = ev.value_p0(L.fn());
    std::printf("  depth-limited Leduc, k=1, equilibrium continuation: value %.6f vs full game %.6f (subgame "
                "exploitability %.2e)\n",
                S.value(0, false) - 1, full, S.exploitability());
    CHECK_NEAR(S.value(0, false) - 1, full, 2e-3);
    CHECK(lv.size() == 5);
  }
  // (b) a weak blueprint; compare blueprint, k=1 and k=4 search (round 1),
  // and k=4 search plus unsafe round-2 re-solving. Exact exploitability.
  for (int64_t bp_iters : {2000, 20000}) {
    Leduc B;
    train_leduc_blueprint(B, bp_iters, 5);
    ExactEval ev(B.tree, LeducSampler::enumerate());
    double e_bp = ev.exploitability(B.fn());
    double res[3];
    for (int variant = 0; variant < 3; variant++) {
      int k = variant == 0 ? 1 : 4;
      Game g;
      B.hands(g);
      std::vector<uint32_t> lv = build_from_blueprint(g, B.bv, 0, {}, true);
      g.finalize();
      build_leaf_values(g, B.bv, lv, {}, k, 5.0, 0, 1, 1);
      Solver S(g, SolverConfig{});
      for (int i = 0; i < 2000; i++) S.iterate();
      res[variant] = composite_exploitability(B, g, S, variant == 2);
    }
    std::printf("  Leduc blueprint (MCCFR %lld it) exploitability %.4f; round-1 search k=1: %.4f, k=4: %.4f, "
                "k=4 + round-2 re-solve: %.4f (chips, ExactEval)\n",
                (long long)bp_iters, e_bp, res[0], res[1], res[2]);
    CHECK(res[0] >= 0 && res[1] >= 0 && res[2] >= 0);
  }
}

// Beliefs: blocked hands get zero weight; reach is the product of the
// player's own action probabilities.
static void test_beliefs() {
  Leduc& L = *g_star;
  std::vector<std::string> line = {"b", "c"};
  int64_t ni = L.tree.find(line);
  CHECK(ni > 0);
  Game g;
  L.hands(g);
  std::vector<double> r0 = blueprint_reach(L.bv, g.hands[0], 0, uint32_t(ni), {2});
  std::vector<double> r1 = blueprint_reach(L.bv, g.hands[1], 1, uint32_t(ni), {2});
  CHECK(r0[2] == 0 && r1[2] == 0);  // card 2 is on the board
  const Node& root = L.tree.nodes[0];
  for (int c = 0; c < 6; c++) {
    if (c == 2) continue;
    double p[MAX_ACTIONS];
    L.bv.policy(root.slot + uint64_t(c / 2) * root.nact, root.nact, p);
    CHECK_NEAR(r0[c], p[1], 1e-12);  // P0 bet ("b" is action 1 after check)
  }
}

// Frozen actions: a re-solve keeps the hero's taken action for its hand.
static void test_freeze() {
  Leduc& L = *g_star;
  Game g;
  L.hands(g);
  build_from_blueprint(g, L.bv, 0, {}, false);
  g.finalize();
  Solver S(g, SolverConfig{});
  S.freeze(0, 0, 1);  // hand J (card 0) of P0 always bets at the root
  for (int i = 0; i < 200; i++) S.iterate();
  double p[MAX_ACTIONS];
  S.average(0, 0, p);
  CHECK(p[1] == 1.0 && p[0] == 0.0);
  S.average(0, 4, p);
  CHECK(p[0] > 0 || p[1] > 0);
}

int main() {
  struct T {
    const char* name;
    void (*fn)();
  } tests[] = {
      {"toy closed form", test_toy_closed_form},
      {"showdown brute force", test_showdown_brute_force},
      {"leduc full game vs ExactEval", test_leduc_full_game},
      {"leduc subgame re-solve", test_leduc_subgame_resolve},
      {"leduc depth-limited search", test_leduc_depth_limited},
      {"beliefs", test_beliefs},
      {"freeze", test_freeze},
  };
  for (auto& t : tests) {
    int before = g_fail;
    double t0 = now_sec();
    std::printf("[%s]\n", t.name);
    t.fn();
    std::printf("  %s (%.2fs)\n", g_fail == before ? "ok" : "FAILED", now_sec() - t0);
  }
  std::printf("%d checks, %d failures\n", g_checks, g_fail);
  return g_fail ? 1 : 0;
}
