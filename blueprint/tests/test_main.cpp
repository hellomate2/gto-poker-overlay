// ============================================================
// test_main.cpp: C++ tests for the blueprint pipeline (`make test`).
//
// No framework: each TEST is a function; CHECK records a failure and keeps
// going; main() prints a summary and exits non-zero on any failure.
// Oracles are external facts (published hand-category counts, canonical
// board counts, Kuhn's game value) or brute-force recomputation.
// ============================================================
#include <algorithm>
#include <set>

#include "abstraction.h"
#include "eval.h"
#include "export.h"
#include "games.h"
#include "mccfr.h"
#include "tree.h"

using namespace bp;

static int g_fail = 0, g_checks = 0;
#define CHECK(cond)                                                       \
  do {                                                                    \
    g_checks++;                                                           \
    if (!(cond)) {                                                        \
      g_fail++;                                                           \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);       \
    }                                                                     \
  } while (0)
#define CHECK_NEAR(a, b, tol) CHECK(std::fabs(double(a) - double(b)) <= (tol))

static int card(const char* s) { return parse_card(s); }

// ---- evaluator -------------------------------------------------------------------

static void test_eval_classes_and_5card_counts() {
  CHECK(eval_tables().num_classes == 7462);
  // Published 5-card frequencies (2,598,960 hands).
  const long long expect[9] = {1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40};
  long long cnt[9] = {0};
  std::set<int> distinct;
  int c[5];
  for (c[0] = 0; c[0] < 52; c[0]++)
    for (c[1] = c[0] + 1; c[1] < 52; c[1]++)
      for (c[2] = c[1] + 1; c[2] < 52; c[2]++)
        for (c[3] = c[2] + 1; c[3] < 52; c[3]++)
          for (c[4] = c[3] + 1; c[4] < 52; c[4]++) {
            int v = eval_n(c, 5);
            cnt[hand_category(uint16_t(v))]++;
            distinct.insert(v);
          }
  for (int i = 0; i < 9; i++) CHECK(cnt[i] == expect[i]);
  CHECK(distinct.size() == 7462);
}

static void test_eval_7card_counts() {
  // Published 7-card frequencies (133,784,560 hands).
  const long long expect[9] = {23294460, 58627800, 31433400, 6461620, 6180020,
                               4047644,  3473184,  224848,   41584};
  const EvalTables& T = eval_tables();
  long long cnt[9] = {0};
  for (int a = 0; a < 52; a++) {
    HandAcc A; A.add(a, T);
    for (int b = a + 1; b < 52; b++) {
      HandAcc B = A; B.add(b, T);
      for (int c = b + 1; c < 52; c++) {
        HandAcc C = B; C.add(c, T);
        for (int d = c + 1; d < 52; d++) {
          HandAcc D = C; D.add(d, T);
          for (int e = d + 1; e < 52; e++) {
            HandAcc E = D; E.add(e, T);
            for (int f = e + 1; f < 52; f++) {
              HandAcc F = E; F.add(f, T);
              for (int g = f + 1; g < 52; g++) {
                HandAcc G = F; G.add(g, T);
                cnt[T.category[eval_acc(G, T)]]++;
              }
            }
          }
        }
      }
    }
  }
  for (int i = 0; i < 9; i++) CHECK(cnt[i] == expect[i]);
}

static int ev(std::initializer_list<const char*> cs) {
  int c[7], n = 0;
  for (const char* s : cs) c[n++] = card(s);
  return eval_n(c, n);
}

static void test_eval_orderings() {
  CHECK(ev({"Ah", "Kh", "Qh", "Jh", "Th"}) == 7462);                 // royal flush is the max
  CHECK(ev({"7h", "5d", "4c", "3s", "2h"}) == 1);                    // 7-high is the min
  CHECK(ev({"5h", "4d", "3c", "2s", "Ah"}) < ev({"6h", "5d", "4c", "3s", "2h"}));  // wheel < 6-high
  CHECK(ev({"5h", "4h", "3h", "2h", "Ah"}) > ev({"Ah", "Ad", "Ac", "As", "Kh"}));  // steel wheel > quads
  CHECK(ev({"Ah", "Ad", "Kc", "Ks", "2h"}) > ev({"Ah", "Ad", "Qc", "Qs", "Kh"}));  // two pair kicker order
  // 7 cards: best five chosen (board plays)
  CHECK(ev({"2c", "3d", "Ah", "Kh", "Qh", "Jh", "Th"}) == 7462);
  // flush beats straight when both present
  CHECK(hand_category(uint16_t(ev({"9h", "8h", "7d", "6h", "5c", "2h", "Kh"}))) == 5);
}

// ---- isomorphism / EHS -------------------------------------------------------------

static void test_board_iso() {
  BoardIso f, t, r;
  f.build(3);
  t.build(4);
  r.build(5);
  // Known counts of suit-isomorphic boards.
  CHECK(f.num_canon() == 1755);
  CHECK(t.num_canon() == 16432);
  CHECK(r.num_canon() == 134459);
  uint64_t wsum = 0;
  for (uint32_t w : f.canon_weight) wsum += w;
  CHECK(wsum == 22100);
  // Lookup is invariant under relabeling suits.
  Rng rng(3);
  for (int it = 0; it < 2000; it++) {
    int b[4];
    uint64_t used = 0;
    for (int i = 0; i < 4; i++) {
      int c;
      do c = int(rng.below(52)); while (used >> c & 1);
      used |= 1ull << c;
      b[i] = c;
    }
    int p = int(rng.below(24)), b2[4], q1, q2;
    for (int i = 0; i < 4; i++) b2[i] = perm_card(b[i], p);
    CHECK(t.lookup(b, q1) == t.lookup(b2, q2));
  }
}

static double brute_ehs(const int board[5], int h0, int h1) {
  uint64_t dead = (1ull << h0) | (1ull << h1);
  for (int i = 0; i < 5; i++) dead |= 1ull << board[i];
  int me[7] = {h0, h1, board[0], board[1], board[2], board[3], board[4]};
  int mv = eval_n(me, 7);
  double s = 0;
  int n = 0;
  for (int a = 0; a < 52; a++)
    for (int b = a + 1; b < 52; b++) {
      if ((dead >> a & 1) || (dead >> b & 1)) continue;
      int op[7] = {a, b, board[0], board[1], board[2], board[3], board[4]};
      int ov = eval_n(op, 7);
      s += mv > ov ? 1.0 : mv == ov ? 0.5 : 0.0;
      n++;
    }
  return s / n;
}

static void test_river_ehs() {
  Rng rng(11);
  for (int it = 0; it < 20; it++) {
    int c[9];
    uint64_t used = 0;
    for (int i = 0; i < 9; i++) {
      int x;
      do x = int(rng.below(52)); while (used >> x & 1);
      used |= 1ull << x;
      c[i] = x;
    }
    const int* board = c + 4;
    float all[NUM_COMBOS], pair[2];
    river_ehs_all(board, all);
    river_ehs_pair(board, c, c + 2, pair);
    double b0 = brute_ehs(board, c[0], c[1]), b1 = brute_ehs(board, c[2], c[3]);
    CHECK_NEAR(all[combo_index(c[0], c[1])], b0, 1e-5);
    CHECK_NEAR(all[combo_index(c[2], c[3])], b1, 1e-5);
    CHECK_NEAR(pair[0], b0, 1e-5);
    CHECK_NEAR(pair[1], b1, 1e-5);
    CHECK(all[combo_index(board[0], c[0])] < 0);  // intersects the board
  }
  // the nuts has EHS 1 (royal on board: everyone ties -> 0.5)
  int royal[5] = {card("Ah"), card("Kh"), card("Qh"), card("Jh"), card("Th")};
  float all[NUM_COMBOS];
  river_ehs_all(royal, all);
  CHECK_NEAR(all[combo_index(card("2c"), card("3d"))], 0.5, 1e-6);
}

static void test_preflop_classes() {
  std::vector<int> cnt(169, 0);
  for (int a = 0; a < 52; a++)
    for (int b = a + 1; b < 52; b++) cnt[preflop_class(a, b)]++;
  int pairs = 0, suited = 0, off = 0;
  for (int i = 0; i < 169; i++) {
    int r = i / 13, c = i % 13;
    if (r == c) {
      CHECK(cnt[i] == 6);
      pairs++;
    } else if (r > c) {
      CHECK(cnt[i] == 4);
      suited++;
    } else {
      CHECK(cnt[i] == 12);
      off++;
    }
  }
  CHECK(pairs == 13 && suited == 78 && off == 78);
  CHECK(preflop_class(card("Ah"), card("Ad")) == 168);
  CHECK(preflop_class(card("Ah"), card("Kh")) == 12 * 13 + 11);  // AKs
  CHECK(preflop_class(card("7h"), card("2d")) == 0 * 13 + 5);     // 72o
}

static void test_kmeans() {
  // three well separated 2-D blobs must be recovered exactly
  std::vector<float> X;
  Rng rng(5);
  const float cx[3] = {0, 10, 20};
  for (int g = 0; g < 3; g++)
    for (int i = 0; i < 200; i++) {
      X.push_back(cx[g] + float(rng.uniform() - 0.5));
      X.push_back(float(rng.uniform() - 0.5));
    }
  std::vector<float> C = kmeans(X, nullptr, 600, 2, 3, 50, 1, 2);
  std::vector<float> xs = {C[0], C[2], C[4]};
  std::sort(xs.begin(), xs.end());
  CHECK_NEAR(xs[0], 0, 0.2);
  CHECK_NEAR(xs[1], 10, 0.2);
  CHECK_NEAR(xs[2], 20, 0.2);
}

// ---- tree --------------------------------------------------------------------------

static void test_trees() {
  BettingTree k, l, h;
  int kb[4] = {3, 1, 1, 1}, lb[4] = {3, 9, 1, 1}, hb[4] = {169, 10, 10, 10};
  k.build(kuhn_config(), kb);
  l.build(leduc_config(), lb);
  size_t kd = 0, linf = 0;
  for (auto& n : k.nodes) kd += n.type == DECISION;
  for (auto& n : l.nodes)
    if (n.type == DECISION) linf += l.buckets[n.street];
  CHECK(kd == 4);       // "", "p", "b", "pb"
  CHECK(linf == 288);   // Leduc has 288 information sets
  CHECK(k.find({"b", "c"}) >= 0 && k.nodes[k.find({"b", "c"})].type == SHOWDOWN);
  h.build(holdem_config("small"), hb);
  // structural invariants of the no-limit tree
  bool ok = true;
  for (size_t i = 0; i < h.nodes.size(); i++) {
    const Node& n = h.nodes[i];
    ok &= n.contrib[0] <= h.cfg.stack && n.contrib[1] <= h.cfg.stack;
    if (n.type == SHOWDOWN) ok &= n.contrib[0] == n.contrib[1];
    if (n.type == DECISION) {
      ok &= n.nact >= 2;
      int32_t prev = -1;
      for (int a = 0; a < n.nact; a++) {
        const Node& c = h.nodes[n.child + a];
        ok &= c.parent == i;
        if (c.act_kind == ACT_BET || c.act_kind == ACT_RAISE || c.act_kind == ACT_ALLIN) {
          int32_t to = c.contrib[n.player];
          ok &= to > prev;  // sizes strictly increasing, all-in last
          prev = to;
          // min raise: raise increment >= big blind
          ok &= to - std::max(n.contrib[0], n.contrib[1]) >= h.cfg.min_bet || to == h.cfg.stack;
        }
      }
    }
  }
  CHECK(ok);
  // SB opens 0.5 pot preflop: call 50 -> pot 200 -> raise by 100 -> to 200
  int64_t open = h.find({"r0.5"});
  CHECK(open > 0 && h.nodes[open].contrib[0] == 200);
  // limp, check -> flop with BB (player 1) first to act
  int64_t flop = h.find({"c", "k"});
  CHECK(flop > 0 && h.nodes[flop].street == 1 && h.nodes[flop].player == 1);
  // all-in, call -> showdown
  int64_t aic = h.find({"a", "c"});
  CHECK(aic > 0 && h.nodes[aic].type == SHOWDOWN && h.nodes[aic].contrib[0] == 10000);
  // terminal utilities
  int64_t fold = h.find({"f"});
  CHECK(fold > 0 && terminal_utility(h.nodes[fold], 0, 0) == -50 && terminal_utility(h.nodes[fold], 1, 0) == 50);
  CHECK(terminal_utility(h.nodes[aic], 0, 2) == 0 && terminal_utility(h.nodes[aic], 1, 0) == -10000);
}

// ---- MCCFR -------------------------------------------------------------------------

template <class Sampler>
static double train_exploit(const TreeConfig& tc, const int* b, int64_t iters, int threads, bool lcfr,
                            bool prune, double* value = nullptr, std::vector<double>* kuhn_strat = nullptr) {
  BettingTree tree;
  tree.build(tc, b);
  McfrConfig m;
  m.threads = threads;
  m.regret_scale = 10000;
  if (lcfr) m.discount_every = 1000, m.lcfr_until = iters / 4;
  if (prune) m.prune_after = iters / 10, m.prune_threshold = -2000000, m.regret_floor = -2100000;
  Trainer<Sampler> tr(tree, Sampler{}, m);
  tr.run(iters, 1e9, iters, nullptr);
  ExactEval ev(tree, Sampler::enumerate());
  StrategyFn avg = [&](uint64_t s, int n, double* o) { tr.average(s, n, o); };
  if (value) *value = ev.value_p0(avg);
  if (kuhn_strat) {
    // P0 opening bet frequency with J, Q, K
    for (int c = 0; c < 3; c++) {
      double p[2];
      tr.average(tree.nodes[0].slot + uint64_t(c) * 2, 2, p);
      kuhn_strat->push_back(p[1]);
    }
  }
  return ev.exploitability(avg);
}

static void test_mccfr_kuhn() {
  int b[4] = {3, 1, 1, 1};
  double v;
  std::vector<double> s;
  double e1 = train_exploit<KuhnSampler>(kuhn_config(), b, 1000000, 1, true, true, &v, &s);
  std::printf("  kuhn 1 thread: exploitability %.5f, value %.5f (target -1/18 = %.5f)\n", e1, v, -1.0 / 18);
  CHECK(e1 < 0.005);
  CHECK_NEAR(v, -1.0 / 18, 0.003);
  // analytic family: bet J with alpha, Q never, K with 3*alpha
  CHECK(s[1] < 0.03);
  CHECK_NEAR(s[2], 3 * s[0], 0.06);
  double e4 = train_exploit<KuhnSampler>(kuhn_config(), b, 1000000, 4, true, true, &v);
  std::printf("  kuhn 4 threads: exploitability %.5f, value %.5f\n", e4, v);
  CHECK(e4 < 0.005);
  // plain (no LCFR, no pruning) also converges
  double e0 = train_exploit<KuhnSampler>(kuhn_config(), b, 1000000, 1, false, false);
  CHECK(e0 < 0.01);
}

static void test_mccfr_leduc() {
  int b[4] = {3, 9, 1, 1};
  double e_short = train_exploit<LeducSampler>(leduc_config(), b, 20000, 2, true, true);
  double e_long = train_exploit<LeducSampler>(leduc_config(), b, 1000000, 2, true, true);
  std::printf("  leduc: exploitability %.4f at 20k iterations -> %.4f at 1M\n", e_short, e_long);
  CHECK(e_long < e_short);
  CHECK(e_long < 0.03);
}

static void test_exact_eval_uniform_kuhn() {
  // Sanity for the best-response code: exploitability of the uniform profile
  // is strictly positive and the BR value is at least the profile value.
  BettingTree tree;
  int b[4] = {3, 1, 1, 1};
  tree.build(kuhn_config(), b);
  ExactEval ev(tree, KuhnSampler::enumerate());
  StrategyFn uni = [](uint64_t, int n, double* o) {
    for (int a = 0; a < n; a++) o[a] = 1.0 / n;
  };
  double v0 = ev.value_p0(uni);
  CHECK(ev.best_response_value(0, uni) >= v0);
  CHECK(ev.best_response_value(1, uni) >= -v0);
  CHECK(ev.exploitability(uni) > 0.1);
}

static void test_checkpoint_and_discount() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  McfrConfig m;
  m.regret_scale = 10000;
  Trainer<LeducSampler> a(tree, LeducSampler{}, m), c(tree, LeducSampler{}, m);
  a.run(5000, 1e9, 5000, nullptr);
  std::string path = "/tmp/bp_test_ckpt.bin";
  CHECK(a.save(path, 1234));
  CHECK(!c.load(path, 999));  // wrong fingerprint is rejected
  CHECK(c.load(path, 1234));
  CHECK(c.iter == a.iter && c.R == a.R && c.S == a.S);
  // discount scales regrets and sums
  std::vector<int32_t> R0 = c.R;
  c.discount(0.5);
  bool ok = true;
  for (size_t i = 0; i < R0.size(); i++) ok &= std::llabs(int64_t(c.R[i]) - std::llround(R0[i] * 0.5)) <= 0;
  CHECK(ok);
  std::remove(path.c_str());
}

static void test_regret_floor() {
  // with a tiny floor, no regret may ever fall below it
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  McfrConfig m;
  m.regret_scale = 10000;
  m.prune_after = 0;
  m.prune_threshold = -40000;
  m.regret_floor = -50000;
  Trainer<LeducSampler> tr(tree, LeducSampler{}, m);
  tr.run(50000, 1e9, 50000, nullptr);
  int32_t mn = *std::min_element(tr.R.begin(), tr.R.end());
  CHECK(mn >= -50000);
  CHECK(mn == -50000);  // the floor is actually reached in this setting
  CHECK(tr.pruned.load() > 0);
}

static void test_quantize_and_export() {
  double p[3] = {0.5, 0.3, 0.2};
  uint8_t q[3];
  quantize255(p, 3, q);
  CHECK(q[0] + q[1] + q[2] == 255);
  CHECK(q[0] == 128 || q[0] == 127);
  double z[2] = {0, 0};
  quantize255(z, 2, q);
  CHECK(q[0] == 0 && q[1] == 0);
  // export Kuhn and verify magic, header length and total size
  BettingTree tree;
  int b[4] = {3, 1, 1, 1};
  tree.build(kuhn_config(), b);
  std::string path = "/tmp/bp_test_export.gpobp";
  auto uni = [](uint64_t, int n, double* o) {
    for (int a = 0; a < n; a++) o[a] = 1.0 / n;
  };
  CHECK(export_policy(tree, uni, [](uint64_t, int) { return true; }, "\"note\":\"test\"", path));
  FILE* f = std::fopen(path.c_str(), "rb");
  char magic[8];
  uint32_t hl;
  CHECK(std::fread(magic, 1, 8, f) == 8 && std::memcmp(magic, "GPOBP001", 8) == 0);
  CHECK(std::fread(&hl, 4, 1, f) == 1);
  std::string hdr(hl, ' ');
  CHECK(std::fread(&hdr[0], 1, hl, f) == hl);
  CHECK(hdr.find("\"num_slots\":24") != std::string::npos);
  std::fseek(f, 0, SEEK_END);
  long sz = std::ftell(f);
  std::fclose(f);
  size_t nodes_off = (12 + hl + 7) / 8 * 8;
  CHECK(size_t(sz) == nodes_off + tree.nodes.size() * NODE_RECORD_BYTES + tree.num_slots);
  std::remove(path.c_str());
}

int main(int argc, char** argv) {
  bool quick = argc > 1 && std::string(argv[1]) == "--quick";
  struct T {
    const char* name;
    void (*fn)();
    bool slow;
  } tests[] = {
      {"eval classes + 5-card counts", test_eval_classes_and_5card_counts, false},
      {"eval 7-card counts", test_eval_7card_counts, true},
      {"eval orderings", test_eval_orderings, false},
      {"board isomorphism", test_board_iso, false},
      {"river EHS vs brute force", test_river_ehs, false},
      {"preflop classes", test_preflop_classes, false},
      {"k-means", test_kmeans, false},
      {"betting trees", test_trees, false},
      {"exact eval sanity", test_exact_eval_uniform_kuhn, false},
      {"MCCFR Kuhn", test_mccfr_kuhn, true},
      {"MCCFR Leduc", test_mccfr_leduc, true},
      {"checkpoint + discount", test_checkpoint_and_discount, false},
      {"regret floor + pruning", test_regret_floor, false},
      {"quantize + export", test_quantize_and_export, false},
  };
  for (auto& t : tests) {
    if (quick && t.slow) continue;
    int before = g_fail;
    double t0 = now_sec();
    t.fn();
    std::printf("%s %s (%.2fs)\n", g_fail == before ? "ok  " : "FAIL", t.name, now_sec() - t0);
  }
  std::printf("%d checks, %d failures\n", g_checks, g_fail);
  return g_fail ? 1 : 0;
}
