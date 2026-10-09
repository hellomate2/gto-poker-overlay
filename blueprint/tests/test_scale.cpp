// ============================================================
// test_scale.cpp: tests for compact.h (PLAN.md M3), `make test-scale`.
//
// Reference for everything here is the dense Trainer in mccfr.h, which the
// Kuhn and Leduc gates in test_main.cpp already validate against exact best
// response: single-threaded, the compact trainer must reproduce its regrets
// and sums bit for bit, so any layout or lazy-allocation bug shows up as a
// mismatch. The snapshot-average gate is checked with ExactEval on Leduc.
// ============================================================
#include <algorithm>
#include <set>

#include "compact.h"
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

static McfrConfig toy_cfg(int threads = 1) {
  McfrConfig m;
  m.threads = threads;
  m.seed = 17;
  m.regret_scale = 10000;
  m.discount_every = 1000;
  m.lcfr_until = 6000;
  m.prune_after = 3000;
  m.prune_threshold = -200000;
  m.regret_floor = -210000;
  return m;
}

static void test_arena() {
  RegretArena ar(100);
  int32_t* a = ar.alloc(60);
  int32_t* b = ar.alloc(30);
  CHECK(b == a + 60);
  int32_t* c = ar.alloc(20);  // does not fit in the 10 left: new chunk, 10 wasted
  CHECK(c != a + 90);
  int32_t* d = ar.alloc(250);  // larger than a chunk: its own chunk
  bool zero = true;
  for (int i = 0; i < 60; i++) zero &= a[i] == 0;
  for (int i = 0; i < 250; i++) zero &= d[i] == 0;
  CHECK(zero);
  CHECK(ar.used_bytes() == 4 * (60 + 30 + 20 + 250));
  CHECK(ar.wasted_bytes() == 4 * (10 + 80));
  CHECK(ar.reserved_bytes() == 4 * (100 + 100 + 250));
}

// Dense vs compact, single thread, same seed and chunking: identical state.
template <class Sampler>
static void equivalence_case(const char* name, const TreeConfig& tc, const int* buckets, int64_t iters) {
  BettingTree tree;
  tree.build(tc, buckets);
  McfrConfig m = toy_cfg();
  Trainer<Sampler> dense(tree, Sampler{}, m);
  CompactTrainer<Sampler> full_lazy(tree, Sampler{}, m, tc.nstreets, true);
  CompactTrainer<Sampler> full_eager(tree, Sampler{}, m, tc.nstreets, false);
  CompactTrainer<Sampler> pre_lazy(tree, Sampler{}, m, 1, true, 64);  // tiny chunks: many arena chunks
  dense.run(iters, 1e9, 700, nullptr);
  full_lazy.run(iters, 1e9, 700, nullptr);
  full_eager.run(iters, 1e9, 700, nullptr);
  pre_lazy.run(iters, 1e9, 700, nullptr);
  CHECK(tc.nstreets == 1 || dense.pruned.load() > 0);  // pruning ran (never on the last street, so not in Kuhn)
  for (auto* c : {&full_lazy, &full_eager}) {
    CHECK(c->dense_regrets() == dense.R);
    CHECK(c->dense_sums() == dense.S);
    CHECK(c->weight == dense.weight && c->iter == dense.iter);
    CHECK(c->visits.load() == dense.visits.load() && c->pruned.load() == dense.pruned.load());
  }
  CHECK(pre_lazy.dense_regrets() == dense.R);
  std::vector<double> s = pre_lazy.dense_sums();
  bool pre_ok = true, post_zero = true;
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    for (uint64_t k = n.slot; k < n.slot + uint64_t(tree.buckets[n.street]) * n.nact; k++) {
      if (n.street == 0) pre_ok &= s[k] == dense.S[k];
      else post_zero &= s[k] == 0.0;
    }
  }
  CHECK(pre_ok);
  CHECK(post_zero);
  // the policy on street 0 equals the dense average; later streets use current
  StrategyFn pol = compact_policy(pre_lazy, nullptr);
  int mism = 0;
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    for (int b = 0; b < tree.buckets[n.street]; b++) {
      uint64_t base = n.slot + uint64_t(b) * n.nact;
      double p[MAX_ACTIONS], q[MAX_ACTIONS];
      pol(base, n.nact, p);
      if (n.street == 0) dense.average(base, n.nact, q);
      else dense.current(base, n.nact, q);
      for (int a = 0; a < n.nact; a++) mism += p[a] != q[a];
    }
  }
  CHECK(mism == 0);
  std::printf("  %s: %lld iterations, %zu slots, dense == compact (lazy, eager, preflop-only average)\n", name,
              (long long)iters, (size_t)tree.num_slots);
}

static void test_equivalence() {
  int kb[4] = {3, 1, 1, 1}, lb[4] = {3, 9, 1, 1};
  equivalence_case<KuhnSampler>("kuhn", kuhn_config(), kb, 9000);
  equivalence_case<LeducSampler>("leduc", leduc_config(), lb, 9000);
}

static void test_lazy_allocation() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  McfrConfig m = toy_cfg();
  LayoutBytes L = layout_bytes(tree, 1);
  CompactTrainer<LeducSampler> c(tree, LeducSampler{}, m, 1, true);
  Trainer<LeducSampler> d(tree, LeducSampler{}, m);
  size_t pre_nodes = 0, all_nodes = 0;
  for (const Node& n : tree.nodes)
    if (n.type == DECISION) all_nodes++, pre_nodes += n.street == 0;
  CHECK(c.allocated_nodes() == pre_nodes);  // eager: the averaged street only
  CHECK(c.regret_bytes() == 4 * L.slots[0]);
  c.run(1, 1e9, 1, nullptr);
  d.run(1, 1e9, 1, nullptr);
  CHECK(c.allocated_nodes() > pre_nodes && c.allocated_nodes() < all_nodes);
  // every node the dense trainer wrote a nonzero regret to is allocated
  int missing = 0;
  uint64_t used = 0;
  std::set<uint32_t> alloc;
  for (uint32_t i : c.decision_nodes())
    if (c.block(i)) alloc.insert(i), used += 4 * uint64_t(tree.buckets[tree.nodes[i].street]) * tree.nodes[i].nact;
  for (uint32_t i : c.decision_nodes()) {
    const Node& n = tree.nodes[i];
    for (uint64_t k = n.slot; k < n.slot + uint64_t(tree.buckets[n.street]) * n.nact; k++)
      if (d.R[k] != 0 && !alloc.count(i)) missing++;
  }
  CHECK(missing == 0);
  CHECK(alloc.size() == c.allocated_nodes());
  CHECK(used == c.regret_bytes());
  c.run(20000, 1e9, 1000, nullptr);
  CHECK(c.allocated_nodes() == all_nodes);
  CHECK(c.regret_bytes() == 4 * tree.num_slots);
  CHECK(c.table_bytes() == L.compact_full);
  std::printf("  leduc: %zu decision nodes; %llu allocated after 1 iteration; tables %llu B compact vs %llu B dense\n",
              all_nodes, (unsigned long long)alloc.size(), (unsigned long long)L.compact_full,
              (unsigned long long)L.dense);
}

// Many threads racing to allocate the same blocks: each node gets exactly one block.
static void test_parallel_allocation() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  for (int rep = 0; rep < 20; rep++) {
    McfrConfig m = toy_cfg(8);
    m.seed = 100 + rep;
    CompactTrainer<LeducSampler> c(tree, LeducSampler{}, m, 1, true);
    c.run(64, 1e9, 64, nullptr);
    uint64_t want = 0;
    for (uint32_t i : c.decision_nodes())
      if (c.block(i)) want += 4 * uint64_t(tree.buckets[tree.nodes[i].street]) * tree.nodes[i].nact;
    CHECK(want == c.regret_bytes());
  }
}

static void test_checkpoint_v2() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  McfrConfig m = toy_cfg();
  std::string path = "/tmp/bp_scale_test_ckpt.bin", v1 = "/tmp/bp_scale_test_v1.bin";
  // partially allocated state round-trips
  CompactTrainer<LeducSampler> a(tree, LeducSampler{}, m, 1, true);
  a.run(2, 1e9, 1, nullptr);
  CHECK(a.allocated_nodes() < a.decision_nodes().size());
  CHECK(a.save(path, 77));
  CHECK(checkpoint_magic(path) == "GPOCKPT2");
  {
    CompactTrainer<LeducSampler> r(tree, LeducSampler{}, m, 1, true);
    CHECK(r.load(path, 77));
    CHECK(r.dense_regrets() == a.dense_regrets() && r.S == a.S && r.iter == a.iter && r.weight == a.weight);
    CHECK(r.allocated_nodes() == a.allocated_nodes());
  }
  // resume reproduces an uninterrupted run (discount and pruning after the save)
  CompactTrainer<LeducSampler> full(tree, LeducSampler{}, m, 1, true), first(tree, LeducSampler{}, m, 1, true);
  full.run(2500, 1e9, 500, nullptr);
  full.run(9000, 1e9, 500, nullptr);
  first.run(2500, 1e9, 500, nullptr);
  CHECK(first.save(path, 77));
  CompactTrainer<LeducSampler> second(tree, LeducSampler{}, m, 1, true);
  CHECK(second.load(path, 77));
  second.run(9000, 1e9, 500, nullptr);
  CHECK(second.dense_regrets() == full.dense_regrets() && second.S == full.S && second.weight == full.weight);
  CHECK(second.pruned.load() > 0);
  // refusals, each with a reason
  {
    CompactTrainer<LeducSampler> r(tree, LeducSampler{}, m, 1, true);
    CHECK(!r.load(path, 78) && r.last_error.find("fingerprint") != std::string::npos);
  }
  {
    CompactTrainer<LeducSampler> r(tree, LeducSampler{}, m, 2, true);
    CHECK(!r.load(path, 77) && r.last_error.find("average-street") != std::string::npos);
  }
  {
    Trainer<LeducSampler> dense(tree, LeducSampler{}, m);  // v1 reader refuses v2
    CHECK(!dense.load(path, 77));
    dense.run(10, 1e9, 10, nullptr);
    CHECK(dense.save(v1, 77));
    CompactTrainer<LeducSampler> r(tree, LeducSampler{}, m, 1, true);
    CHECK(!r.load(v1, 77) && r.last_error.find("GPOCKPT1") != std::string::npos);
  }
  {
    FILE* f = std::fopen(path.c_str(), "ab");  // trailing garbage
    std::fputc('x', f);
    std::fclose(f);
    CompactTrainer<LeducSampler> r(tree, LeducSampler{}, m, 1, true);
    CHECK(!r.load(path, 77) && r.last_error.find("trailing") != std::string::npos);
    f = std::fopen(path.c_str(), "r+b");  // truncated
    CHECK(f && ::ftruncate(::fileno(f), 200) == 0);
    std::fclose(f);
    CompactTrainer<LeducSampler> r2(tree, LeducSampler{}, m, 1, true);
    CHECK(!r2.load(path, 77) && !r2.last_error.empty());
  }
  std::remove(path.c_str());
  std::remove(v1.c_str());
}

// Snapshots averaged from checkpoint files equal snapshots averaged in memory.
static void test_snapshot_offline() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  McfrConfig m = toy_cfg();
  CompactTrainer<LeducSampler> c(tree, LeducSampler{}, m, 1, true);
  SnapshotAverage live(tree, 1), offline(tree, 1);
  std::vector<std::string> files;
  for (int k = 1; k <= 4; k++) {
    c.run(k * 1500, 1e9, 500, nullptr);
    live.add(c);
    files.push_back("/tmp/bp_scale_test_snap" + std::to_string(k) + ".bin");
    CHECK(c.save(files.back(), 5));
  }
  for (auto& f : files) {
    CompactTrainer<LeducSampler> r(tree, LeducSampler{}, m, 1, true);
    CHECK(r.load(f, 5));
    offline.add(r);
    std::remove(f.c_str());
  }
  CHECK(live.count == 4 && offline.count == 4 && live.sum == offline.sum);
  // the streaming on-disk accumulator gives the same sums
  {
    std::string acc = "/tmp/bp_scale_test_acc.f32", err;
    std::remove(acc.c_str());
    CompactTrainer<LeducSampler> c2(tree, LeducSampler{}, m, 1, true);
    for (int k = 1; k <= 4; k++) {
      c2.run(k * 1500, 1e9, 500, nullptr);
      CHECK(snapshot_accumulate(c2, 1, acc, 5, &err));
    }
    SnapshotAverage from_file(tree, 1);
    CHECK(from_file.load_file(acc, 5, &err));
    CHECK(from_file.count == 4 && from_file.sum == live.sum);
    SnapshotAverage wrong(tree, 1);
    CHECK(!wrong.load_file(acc, 6, &err));
    CHECK(!snapshot_accumulate(c2, 1, acc, 6, &err));  // other run's file is refused
    std::remove(acc.c_str());
  }
  // street-0 slots are not covered (they keep the running average)
  bool pre_zero = true;
  for (const Node& n : tree.nodes)
    if (n.type == DECISION && n.street == 0)
      for (uint64_t k = n.slot; k < n.slot + uint64_t(tree.buckets[0]) * n.nact; k++) pre_zero &= live.sum[k] == 0.f;
  CHECK(pre_zero);
}

// PLAN.md M3 gate, in miniature: Leduc with a preflop-only running average
// plus postflop snapshot averaging stays within 2x of the dense average's
// exploitability on the same seed and schedule. The full-size gate (4M
// iterations, 4 threads) is `bp scale gate --game leduc`.
static void test_snapshot_gate() {
  BettingTree tree;
  int b[4] = {3, 9, 1, 1};
  tree.build(leduc_config(), b);
  const int64_t iters = 4000000;  // the PLAN.md gate size; 1 thread so the result is deterministic
  McfrConfig m;
  m.threads = 1;
  m.seed = 1;
  m.regret_scale = 10000;
  m.discount_every = 1000;
  m.lcfr_until = iters / 4;
  m.prune_after = iters / 10;
  m.prune_threshold = -2000000;
  m.regret_floor = -2100000;
  ExactEval ev(tree, LeducSampler::enumerate());
  Trainer<LeducSampler> dense(tree, LeducSampler{}, m);
  dense.run(iters, 1e9, 10000, nullptr);
  StrategyFn davg = [&](uint64_t bs, int n, double* o) { dense.average(bs, n, o); };
  double e_dense = ev.exploitability(davg);
  CompactTrainer<LeducSampler> c(tree, LeducSampler{}, m, 1, true);
  SnapshotAverage snap(tree, 1);
  const int64_t every = iters / 1000, start = iters / 4;  // bp scale gate defaults
  while (c.iter < iters) {
    c.run(std::min(iters, c.iter + every), 1e9, every, nullptr);
    if (c.iter >= start) snap.add(c);
  }
  double e_snap = ev.exploitability(compact_policy(c, &snap));
  double e_cur = ev.exploitability(compact_current(c));
  std::printf("  leduc %lld it: dense average %.5f, preflop avg + postflop snapshots %.5f (%lld snapshots), "
              "current %.5f\n",
              (long long)iters, e_dense, e_snap, (long long)snap.count, e_cur);
  CHECK(e_snap <= 2 * e_dense);
}

int main(int argc, char** argv) {
  bool quick = argc > 1 && std::string(argv[1]) == "--quick";
  struct T {
    const char* name;
    void (*fn)();
    bool slow;
  } tests[] = {
      {"regret arena", test_arena, false},
      {"compact == dense (Kuhn, Leduc)", test_equivalence, false},
      {"lazy allocation", test_lazy_allocation, false},
      {"parallel first-visit allocation", test_parallel_allocation, false},
      {"checkpoint v2 + refusals", test_checkpoint_v2, false},
      {"snapshot average offline == live", test_snapshot_offline, false},
      {"Leduc snapshot gate (4M)", test_snapshot_gate, true},
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
