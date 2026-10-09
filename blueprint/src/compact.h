// ============================================================
// compact.h: memory-lean variant of the MCCFR trainer (PLAN.md M3).
//
// The dense Trainer in mccfr.h keeps, for every slot (node, bucket, action),
// an int32 regret and a double average-strategy sum: 12 bytes per slot, all
// allocated up front. CompactTrainer runs the same external-sampling MCCFR
// (same traversal, same RNG stream, same Linear-CFR discount and pruning
// rules) with two Pluribus memory changes (Brown & Sandholm, Science 2019,
// supplementary; summarized in gpo-research/pluribus.md section 3):
//
//   1. Running average only on the first `avg_streets` streets (default 1 =
//      preflop). Later streets keep regrets only, 4 bytes per slot. Their
//      blueprint is the average of current-strategy snapshots taken during
//      training (SnapshotAverage below; Pluribus saved the current strategy
//      every 200 minutes after minute 800 and averaged the snapshots offline).
//   2. Lazy allocation: a node's regret block (buckets x actions int32) is
//      created the first time a traverser writes to it. Reads of a block that
//      does not exist yet see all-zero regrets, i.e. the uniform strategy,
//      which is exactly what the dense table would hold there. Blocks come
//      from a bump arena (RegretArena) in first-visit order, so touched memory
//      is the memory actually used. Average-strategy streets are allocated up
//      front (Pluribus allocated preflop up front too).
//
// With avg_streets = nstreets the compact trainer is the dense trainer with a
// different memory layout: single-threaded, it produces bit-identical regrets
// and sums for the same seed (tests/test_scale.cpp checks this on Kuhn and
// Leduc). With avg_streets = 1 its regrets are still identical (averaging
// never changes the traversal) and its preflop sums equal the dense sums.
//
// Checkpoints use a new, versioned format, "GPOCKPT2"; loading a dense
// "GPOCKPT1" file (or any other magic) is refused with a message, and the
// dense trainer refuses GPOCKPT2 files because its magic check fails.
// ============================================================
#pragma once

#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "mccfr.h"

namespace bp {

// ---- arena ------------------------------------------------------------------------
// Bump allocator for regret blocks. Chunks come from calloc, so they are zero
// and, for large sizes, backed by untouched zero pages until written: resident
// memory follows `used_bytes()`, not `reserved_bytes()`. Not thread-safe by
// itself; CompactTrainer calls it under its allocation mutex.
class RegretArena {
 public:
  explicit RegretArena(size_t chunk_ints = size_t(1) << 22) : chunk_ints_(chunk_ints) {}
  RegretArena(const RegretArena&) = delete;
  RegretArena& operator=(const RegretArena&) = delete;
  ~RegretArena() { clear(); }

  int32_t* alloc(size_t n) {
    if (n == 0) n = 1;
    if (cur_ == nullptr || cur_used_ + n > cur_cap_) {
      wasted_ints_ += cur_ ? cur_cap_ - cur_used_ : 0;
      size_t cap = std::max(chunk_ints_, n);
      cur_ = static_cast<int32_t*>(std::calloc(cap, sizeof(int32_t)));
      if (!cur_) die("regret arena: out of memory");
      chunks_.push_back(cur_);
      cur_cap_ = cap;
      cur_used_ = 0;
      reserved_ints_ += cap;
    }
    int32_t* p = cur_ + cur_used_;
    cur_used_ += n;
    used_ints_ += n;
    return p;
  }
  void clear() {
    for (int32_t* c : chunks_) std::free(c);
    chunks_.clear();
    cur_ = nullptr;
    cur_used_ = cur_cap_ = used_ints_ = reserved_ints_ = wasted_ints_ = 0;
  }
  uint64_t used_bytes() const { return uint64_t(used_ints_) * 4; }
  uint64_t reserved_bytes() const { return uint64_t(reserved_ints_) * 4; }
  uint64_t wasted_bytes() const { return uint64_t(wasted_ints_) * 4; }

 private:
  size_t chunk_ints_;
  std::vector<int32_t*> chunks_;
  int32_t* cur_ = nullptr;
  size_t cur_used_ = 0, cur_cap_ = 0, used_ints_ = 0, reserved_ints_ = 0, wasted_ints_ = 0;
};

// ---- memory model -------------------------------------------------------------------
// Bytes for a tree under each layout, from the tree alone (no training).
struct LayoutBytes {
  uint64_t slots[4] = {0, 0, 0, 0};
  uint64_t decision_nodes = 0, nodes = 0;
  uint64_t dense = 0;          // 12 B/slot (mccfr.h Trainer)
  uint64_t compact_full = 0;   // compact layout with every block allocated
  uint64_t avg_slots = 0;      // slots that keep a double running average
  uint64_t index_bytes = 0;    // per-node block pointer + average offset
};

inline LayoutBytes layout_bytes(const BettingTree& t, int avg_streets) {
  LayoutBytes L;
  L.nodes = t.nodes.size();
  for (const Node& n : t.nodes) {
    if (n.type != DECISION) continue;
    L.decision_nodes++;
    uint64_t s = uint64_t(t.buckets[n.street]) * n.nact;
    L.slots[n.street] += s;
    if (n.street < avg_streets) L.avg_slots += s;
  }
  L.dense = t.num_slots * 12;
  L.index_bytes = L.nodes * (sizeof(int32_t*) + sizeof(uint64_t));
  L.compact_full = t.num_slots * 4 + L.avg_slots * 8 + L.index_bytes;
  return L;
}

// One block of lines for `bp tree` and `bp scale tree`.
inline void print_layout(const BettingTree& t, int avg_streets, FILE* out) {
  LayoutBytes L = layout_bytes(t, avg_streets);
  std::fprintf(out, "  compact layout (bp scale): bytes per slot by street:");
  for (int s = 0; s < t.cfg.nstreets; s++) std::fprintf(out, " %d", s < avg_streets ? 12 : 4);
  std::fprintf(out, "  (int32 regret%s)\n", avg_streets > 0 ? ", + double average on the first street(s)" : "");
  uint64_t post = 0;
  for (int s = avg_streets; s < t.cfg.nstreets; s++) post += L.slots[s];
  std::fprintf(out,
               "  compact tables, all blocks allocated: %.1f MB (dense %.1f MB, ratio %.3f); "
               "postflop slots %llu at 4 B = %.1f MB; node index %.2f MB\n",
               L.compact_full / 1e6, L.dense / 1e6, double(L.compact_full) / double(L.dense),
               (unsigned long long)post, post * 4.0 / 1e6, L.index_bytes / 1e6);
}

// ---- trainer ------------------------------------------------------------------------
template <class Sampler>
class CompactTrainer {
 public:
  static constexpr uint64_t NONE = ~uint64_t(0);
  const BettingTree& tree;
  Sampler sampler;
  McfrConfig cfg;
  int avg_streets;   // streets [0, avg_streets) keep a running average
  bool lazy;         // false: allocate every block at construction
  int64_t iter = 0;
  double weight = 0;
  std::atomic<uint64_t> visits{0};
  std::atomic<uint64_t> explored{0}, pruned{0};
  std::string last_error;  // reason the last load() failed

  CompactTrainer(const BettingTree& t, const Sampler& s, const McfrConfig& c, int avg_streets_ = 1,
                 bool lazy_ = true, size_t arena_chunk_ints = size_t(1) << 22)
      : tree(t), sampler(s), cfg(c), avg_streets(avg_streets_), lazy(lazy_), arena_(arena_chunk_ints) {
    blk_.assign(t.nodes.size(), nullptr);
    avg_off_.assign(t.nodes.size(), NONE);
    uint64_t off = 0;
    for (uint32_t i = 0; i < t.nodes.size(); i++) {
      const Node& n = t.nodes[i];
      if (n.type != DECISION) continue;
      slot_nodes_.push_back(i);
      if (n.street < avg_streets) {
        avg_off_[i] = off;
        off += block_len(n);
      }
    }
    S.assign(off, 0.0);
    for (uint32_t i : slot_nodes_)
      if (!lazy || t.nodes[i].street < avg_streets) alloc_block(i);
  }

  // ---- memory accounting ----
  uint64_t allocated_nodes() const { return alloc_order_.size(); }
  uint64_t regret_bytes() const { return arena_.used_bytes(); }
  uint64_t regret_reserved_bytes() const { return arena_.reserved_bytes(); }
  uint64_t avg_bytes() const { return uint64_t(S.size()) * 8; }
  uint64_t index_bytes() const { return uint64_t(blk_.size()) * (sizeof(int32_t*) + sizeof(uint64_t)); }
  uint64_t table_bytes() const { return regret_bytes() + avg_bytes() + index_bytes(); }
  uint64_t allocated_slots_on_street(int s) const {
    uint64_t t = 0;
    for (uint32_t i : alloc_order_)
      if (tree.nodes[i].street == s) t += block_len(tree.nodes[i]);
    return t;
  }

  // ---- access ----
  size_t block_len(const Node& n) const { return size_t(tree.buckets[n.street]) * n.nact; }
  // Regret block of node ni, or nullptr if never allocated (all zeros).
  const int32_t* block(uint32_t ni) const { return __atomic_load_n(&blk_[ni], __ATOMIC_ACQUIRE); }
  int32_t regret(uint32_t ni, int bucket, int a) const {
    const int32_t* b = block(ni);
    return b ? aload(b + size_t(bucket) * tree.nodes[ni].nact + a) : 0;
  }
  // Dense copy of all regrets (unallocated blocks as zeros), slot order of the tree.
  std::vector<int32_t> dense_regrets() const {
    std::vector<int32_t> out(tree.num_slots, 0);
    for (uint32_t i : alloc_order_) {
      const Node& n = tree.nodes[i];
      std::copy(blk_[i], blk_[i] + block_len(n), out.begin() + int64_t(n.slot));
    }
    return out;
  }
  // Dense copy of the average sums (zeros on streets without an average).
  std::vector<double> dense_sums() const {
    std::vector<double> out(tree.num_slots, 0.0);
    for (uint32_t i : slot_nodes_)
      if (avg_off_[i] != NONE)
        std::copy(S.begin() + int64_t(avg_off_[i]), S.begin() + int64_t(avg_off_[i] + block_len(tree.nodes[i])),
                  out.begin() + int64_t(tree.nodes[i].slot));
    return out;
  }
  // Decision node that owns global slot index `slot` (slots ascend with node index).
  uint32_t node_of_slot(uint64_t slot) const {
    size_t lo = 0, hi = slot_nodes_.size();
    while (hi - lo > 1) {
      size_t mid = (lo + hi) / 2;
      if (tree.nodes[slot_nodes_[mid]].slot <= slot) lo = mid;
      else hi = mid;
    }
    return slot_nodes_[lo];
  }
  const std::vector<uint32_t>& decision_nodes() const { return slot_nodes_; }

  void current(uint32_t ni, int bucket, double* out) const {
    const Node& n = tree.nodes[ni];
    const int32_t* b = block(ni);
    if (!b) {
      for (int a = 0; a < n.nact; a++) out[a] = 1.0 / n.nact;
      return;
    }
    regret_match(b + size_t(bucket) * n.nact, n.nact, out);
  }
  // Running average where one is kept and non-empty, else the current strategy.
  void average(uint32_t ni, int bucket, double* out) const {
    const Node& n = tree.nodes[ni];
    if (avg_off_[ni] != NONE) {
      const double* s = &S[avg_off_[ni] + size_t(bucket) * n.nact];
      double tot = 0;
      for (int a = 0; a < n.nact; a++) tot += s[a];
      if (tot > 0) {
        for (int a = 0; a < n.nact; a++) out[a] = s[a] / tot;
        return;
      }
    }
    current(ni, bucket, out);
  }
  bool has_average(uint32_t ni) const { return avg_off_[ni] != NONE; }
  bool visited(uint32_t ni, int bucket) const {
    const Node& n = tree.nodes[ni];
    if (avg_off_[ni] != NONE)
      for (int a = 0; a < n.nact; a++)
        if (S[avg_off_[ni] + size_t(bucket) * n.nact + a] > 0) return true;
    const int32_t* b = block(ni);
    if (b)
      for (int a = 0; a < n.nact; a++)
        if (b[size_t(bucket) * n.nact + a] != 0) return true;
    return false;
  }

  // ---- training (mirrors Trainer::run / run_chunk / traverse exactly) ----
  void run(int64_t target_iter, double max_seconds, int64_t chunk,
           const std::function<void(CompactTrainer&)>& on_chunk) {
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

  struct Counters {
    uint64_t visits = 0, explored = 0, pruned = 0;
  };

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

  double traverse(uint32_t ni, int p, const Deal& d, Rng& rng, bool prune, Counters& cnt) {
    const Node& n = tree.nodes[ni];
    if (n.type != DECISION) return terminal_utility(n, p, d.winner);
    cnt.visits++;
    const int pl = n.player, na = n.nact;
    const size_t row = size_t(d.bucket[pl][n.street]) * na;
    double sigma[MAX_ACTIONS];
    if (pl == p) {
      int32_t* Rr = write_block(ni) + row;
      regret_match(Rr, na, sigma);
      double va[MAX_ACTIONS];
      bool expl[MAX_ACTIONS];
      double v = 0;
      // Same pruning rule as Trainer::traverse (see the comment there).
      const bool prune_here = prune && n.street + 1 < tree.cfg.nstreets;
      for (int a = 0; a < na; a++) {
        const Node& c = tree.nodes[n.child + a];
        if (prune_here && sigma[a] == 0.0 && c.type == DECISION && aload(Rr + a) < cfg.prune_threshold) {
          expl[a] = false;
          cnt.pruned++;
          continue;
        }
        expl[a] = true;
        cnt.explored++;
        va[a] = traverse(n.child + a, p, d, rng, prune, cnt);
        v += sigma[a] * va[a];
      }
      for (int a = 0; a < na; a++) {
        if (!expl[a]) continue;
        int64_t nv = int64_t(aload(Rr + a)) + std::llround((va[a] - v) * cfg.regret_scale);
        if (nv < cfg.regret_floor) nv = cfg.regret_floor;
        if (nv > INT32_MAX) nv = INT32_MAX;
        astore(Rr + a, int32_t(nv));
      }
      return v;
    }
    const int32_t* b = block(ni);
    if (b) regret_match(b + row, na, sigma);
    else
      for (int a = 0; a < na; a++) sigma[a] = 1.0 / na;
    if (avg_off_[ni] != NONE) {
      double* Sr = &S[avg_off_[ni] + row];
      for (int a = 0; a < na; a++) astore(Sr + a, aload(Sr + a) + sigma[a]);
    }
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
    const size_t N = alloc_order_.size();
    int T = std::max(1, cfg.threads);
    auto work = [&](size_t lo, size_t hi) {
      for (size_t k = lo; k < hi; k++) {
        uint32_t i = alloc_order_[k];
        int32_t* b = blk_[i];
        size_t len = block_len(tree.nodes[i]);
        for (size_t j = 0; j < len; j++) b[j] = int32_t(std::llround(double(b[j]) * f));
      }
      // the average table is split by the same fractions
      size_t s0 = S.size() * lo / std::max<size_t>(1, N), s1 = S.size() * hi / std::max<size_t>(1, N);
      for (size_t j = s0; j < s1; j++) S[j] *= f;
    };
    if (N == 0) {
      for (double& x : S) x *= f;
      return;
    }
    std::vector<std::thread> pool;
    for (int t = 0; t < T; t++) pool.emplace_back(work, N * t / T, N * (t + 1) / T);
    for (auto& th : pool) th.join();
  }

  double avg_positive_regret() const {
    double tot = 0;
    for (uint32_t i : alloc_order_) {
      const Node& n = tree.nodes[i];
      const int32_t* b = blk_[i];
      for (int k = 0; k < tree.buckets[n.street]; k++) {
        int32_t m = 0;
        for (int a = 0; a < n.nact; a++) m = std::max(m, b[size_t(k) * n.nact + a]);
        tot += m;
      }
    }
    return weight > 0 ? tot / cfg.regret_scale / weight : 0;
  }

  // ---- checkpoints: format GPOCKPT2 ----
  // magic[8] "GPOCKPT2", u64 cfg_hash, u32 avg_streets, u32 reserved (0),
  // i64 iter, f64 weight, u64 num_nodes, u64 num_slots, u64 num_blocks,
  // then per allocated block in node order: u32 node index, block_len x i32,
  // then u64 num_avg, num_avg x f64, then trailer magic[8] "GPOCKEND".
  bool save(const std::string& path, uint64_t cfg_hash) const {
    std::string tmp = path + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    std::vector<uint32_t> order(alloc_order_);
    std::sort(order.begin(), order.end());
    const uint32_t as = uint32_t(avg_streets), zero = 0;
    const uint64_t nn = tree.nodes.size(), ns = tree.num_slots, nb = order.size(), na = S.size();
    bool ok = std::fwrite(MAGIC, 1, 8, f) == 8 && std::fwrite(&cfg_hash, 8, 1, f) == 1 &&
              std::fwrite(&as, 4, 1, f) == 1 && std::fwrite(&zero, 4, 1, f) == 1 &&
              std::fwrite(&iter, 8, 1, f) == 1 && std::fwrite(&weight, 8, 1, f) == 1 &&
              std::fwrite(&nn, 8, 1, f) == 1 && std::fwrite(&ns, 8, 1, f) == 1 && std::fwrite(&nb, 8, 1, f) == 1;
    for (size_t k = 0; ok && k < order.size(); k++) {
      uint32_t i = order[k];
      size_t len = block_len(tree.nodes[i]);
      ok = std::fwrite(&i, 4, 1, f) == 1 && std::fwrite(blk_[i], 4, len, f) == len;
    }
    ok = ok && std::fwrite(&na, 8, 1, f) == 1 && std::fwrite(S.data(), 8, na, f) == na &&
         std::fwrite(TRAILER, 1, 8, f) == 8;
    ok = ok && std::fflush(f) == 0 && ::fsync(::fileno(f)) == 0;
    ok = (std::fclose(f) == 0) && ok;
    return ok && std::rename(tmp.c_str(), path.c_str()) == 0;
  }

  // Loads into a freshly constructed trainer (no blocks allocated past the
  // eager ones). On failure the trainer must be discarded; last_error says why.
  bool load(const std::string& path, uint64_t cfg_hash) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return fail("cannot open " + path);
    char magic[8];
    bool ok = std::fread(magic, 1, 8, f) == 8;
    if (!ok) return fail_close(f, "file shorter than a header");
    if (std::memcmp(magic, "GPOCKPT1", 8) == 0)
      return fail_close(f, "dense v1 checkpoint (GPOCKPT1, 12 B/slot from bp train); the compact trainer reads "
                           "only GPOCKPT2. Use bp train / h2h / export for v1 files");
    if (std::memcmp(magic, MAGIC, 8) != 0) return fail_close(f, "unknown checkpoint format (bad magic)");
    uint64_t h, nn, ns, nb, na;
    uint32_t as, rsv;
    int64_t it;
    double w;
    ok = std::fread(&h, 8, 1, f) == 1 && std::fread(&as, 4, 1, f) == 1 && std::fread(&rsv, 4, 1, f) == 1 &&
         std::fread(&it, 8, 1, f) == 1 && std::fread(&w, 8, 1, f) == 1 && std::fread(&nn, 8, 1, f) == 1 &&
         std::fread(&ns, 8, 1, f) == 1 && std::fread(&nb, 8, 1, f) == 1;
    if (!ok) return fail_close(f, "truncated header");
    if (h != cfg_hash) return fail_close(f, "tree/abstraction fingerprint differs");
    if (int(as) != avg_streets) return fail_close(f, "average-street setting differs");
    if (nn != tree.nodes.size() || ns != tree.num_slots) return fail_close(f, "tree size differs");
    if (nb > slot_nodes_.size()) return fail_close(f, "too many blocks");
    uint32_t prev = 0;
    for (uint64_t k = 0; k < nb; k++) {
      uint32_t i;
      if (std::fread(&i, 4, 1, f) != 1) return fail_close(f, "truncated block list");
      if (i >= tree.nodes.size() || tree.nodes[i].type != DECISION || (k > 0 && i <= prev))
        return fail_close(f, "bad block index");
      prev = i;
      int32_t* b = blk_[i] ? blk_[i] : alloc_block(i);
      size_t len = block_len(tree.nodes[i]);
      if (std::fread(b, 4, len, f) != len) return fail_close(f, "truncated block");
    }
    ok = std::fread(&na, 8, 1, f) == 1 && na == S.size() && std::fread(S.data(), 8, na, f) == na;
    if (!ok) return fail_close(f, "average table missing or wrong size");
    char tr[8];
    ok = std::fread(tr, 1, 8, f) == 8 && std::memcmp(tr, TRAILER, 8) == 0;
    if (!ok) return fail_close(f, "missing end marker (truncated)");
    char extra;
    if (std::fread(&extra, 1, 1, f) != 0) return fail_close(f, "trailing bytes after end marker");
    std::fclose(f);
    iter = it;
    weight = w;
    last_error.clear();
    return true;
  }

 private:
  static constexpr char MAGIC[9] = "GPOCKPT2";
  static constexpr char TRAILER[9] = "GPOCKEND";
  std::vector<int32_t*> blk_;
  std::vector<uint64_t> avg_off_;
  std::vector<uint32_t> slot_nodes_;  // decision nodes in index (= slot) order
  std::vector<uint32_t> alloc_order_;
  std::mutex alloc_mu_;
  RegretArena arena_;

 public:
  std::vector<double> S;  // running-average sums for streets < avg_streets

 private:
  int32_t* alloc_block(uint32_t ni) {
    int32_t* b = arena_.alloc(block_len(tree.nodes[ni]));
    alloc_order_.push_back(ni);
    __atomic_store_n(&blk_[ni], b, __ATOMIC_RELEASE);
    return b;
  }
  int32_t* write_block(uint32_t ni) {
    int32_t* b = __atomic_load_n(&blk_[ni], __ATOMIC_ACQUIRE);
    if (b) return b;
    std::lock_guard<std::mutex> g(alloc_mu_);
    b = __atomic_load_n(&blk_[ni], __ATOMIC_RELAXED);
    return b ? b : alloc_block(ni);
  }
  bool fail(const std::string& why) {
    last_error = why;
    return false;
  }
  bool fail_close(FILE* f, const std::string& why) {
    std::fclose(f);
    return fail(why);
  }
};

template <class Sampler>
constexpr char CompactTrainer<Sampler>::MAGIC[9];
template <class Sampler>
constexpr char CompactTrainer<Sampler>::TRAILER[9];

// First 8 bytes of a checkpoint file ("GPOCKPT1", "GPOCKPT2"), or "" if unreadable.
inline std::string checkpoint_magic(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return "";
  char m[8];
  size_t r = std::fread(m, 1, 8, f);
  std::fclose(f);
  return r == 8 ? std::string(m, 8) : "";
}

// ---- snapshot averaging ----------------------------------------------------------
// Uniform average of current-strategy snapshots on streets >= from_street
// (Pluribus postflop blueprint). Sums are float, 4 B per covered slot; this
// table lives in the averaging or export process, or, for the toy-game gates,
// next to the trainer. Each add() visits every bucket of every covered node,
// so a never-allocated node contributes the uniform strategy, exactly as a
// dense current-strategy snapshot would.
class SnapshotAverage {
 public:
  SnapshotAverage(const BettingTree& t, int from_street) : tree(t), from(from_street), sum(t.num_slots, 0.f) {}
  const BettingTree& tree;
  int from;
  std::vector<float> sum;
  int64_t count = 0;

  template <class T>
  void add(const T& tr) {
    double p[MAX_ACTIONS];
    for (uint32_t i : tr.decision_nodes()) {
      const Node& n = tree.nodes[i];
      if (n.street < from) continue;
      for (int b = 0; b < tree.buckets[n.street]; b++) {
        tr.current(i, b, p);
        float* s = &sum[n.slot + uint64_t(b) * n.nact];
        for (int a = 0; a < n.nact; a++) s[a] += float(p[a]);
      }
    }
    count++;
  }
  // Average at global slot base; returns false if there is no snapshot yet.
  bool get(uint64_t base, int na, double* out) const {
    if (count == 0) return false;
    double tot = 0;
    for (int a = 0; a < na; a++) tot += sum[base + a];
    if (tot <= 0) return false;
    for (int a = 0; a < na; a++) out[a] = sum[base + a] / tot;
    return true;
  }
  // Load a snapshot accumulator file written by snapshot_accumulate().
  bool load_file(const std::string& path, uint64_t cfg_hash, std::string* err) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return *err = "cannot open " + path, false;
    char m[8];
    uint64_t h, ns;
    int64_t c;
    int32_t fr, rsv;
    bool ok = std::fread(m, 1, 8, f) == 8 && std::memcmp(m, "GPOSNAV1", 8) == 0 && std::fread(&h, 8, 1, f) == 1 &&
              std::fread(&ns, 8, 1, f) == 1 && std::fread(&c, 8, 1, f) == 1 && std::fread(&fr, 4, 1, f) == 1 &&
              std::fread(&rsv, 4, 1, f) == 1;
    if (!ok) return std::fclose(f), *err = "bad header (not GPOSNAV1)", false;
    if (h != cfg_hash || ns != tree.num_slots || fr != from)
      return std::fclose(f), *err = "accumulator was written for another tree or street split", false;
    ok = std::fread(sum.data(), 4, ns, f) == ns;
    std::fclose(f);
    if (!ok) return *err = "truncated accumulator", false;
    count = c;
    return true;
  }
};

// On-disk running sum of current-strategy snapshots, so the number of
// snapshots is not limited by disk space or by trainer memory. The Leduc gate
// needs hundreds of snapshots to stay within 2x of the dense average (see
// README, "Compact trainer"), far more than one checkpoint file per snapshot
// allows on a large tree. Layout: "GPOSNAV1", u64 cfg_hash, u64 num_slots,
// i64 count, i32 from_street, i32 reserved, then num_slots float32 sums in
// tree slot order (streets < from_street stay zero; the file is sparse).
// Each call streams node by node (pread, add, pwrite), so its memory is one
// node block. The count is written last; a crash in the middle of a call can
// leave one partial snapshot in the sums, which shifts the average by at most
// one snapshot's weight.
template <class T>
bool snapshot_accumulate(const T& tr, int from_street, const std::string& path, uint64_t cfg_hash, std::string* err) {
  const BettingTree& tree = tr.tree;
  const off_t HDR = 40;
  FILE* f = std::fopen(path.c_str(), "r+b");
  int64_t count = 0;
  if (!f) {
    f = std::fopen(path.c_str(), "w+b");
    if (!f) return *err = "cannot create " + path, false;
    uint64_t ns = tree.num_slots;
    int32_t fr = from_street, rsv = 0;
    bool ok = std::fwrite("GPOSNAV1", 1, 8, f) == 8 && std::fwrite(&cfg_hash, 8, 1, f) == 1 &&
              std::fwrite(&ns, 8, 1, f) == 1 && std::fwrite(&count, 8, 1, f) == 1 && std::fwrite(&fr, 4, 1, f) == 1 &&
              std::fwrite(&rsv, 4, 1, f) == 1 && std::fflush(f) == 0 &&
              ::ftruncate(::fileno(f), HDR + off_t(ns) * 4) == 0;
    if (!ok) return std::fclose(f), *err = "cannot initialize " + path, false;
  } else {
    char m[8];
    uint64_t h, ns;
    int32_t fr;
    bool ok = std::fread(m, 1, 8, f) == 8 && std::memcmp(m, "GPOSNAV1", 8) == 0 && std::fread(&h, 8, 1, f) == 1 &&
              std::fread(&ns, 8, 1, f) == 1 && std::fread(&count, 8, 1, f) == 1 && std::fread(&fr, 4, 1, f) == 1;
    if (!ok || h != cfg_hash || ns != tree.num_slots || fr != from_street)
      return std::fclose(f), *err = "existing accumulator does not match this run", false;
  }
  const int fd = ::fileno(f);
  std::vector<float> buf;
  double p[MAX_ACTIONS];
  for (uint32_t i : tr.decision_nodes()) {
    const Node& n = tree.nodes[i];
    if (n.street < from_street) continue;
    size_t len = size_t(tree.buckets[n.street]) * n.nact;
    buf.resize(len);
    off_t off = HDR + off_t(n.slot) * 4;
    if (::pread(fd, buf.data(), len * 4, off) != ssize_t(len * 4)) return std::fclose(f), *err = "read failed", false;
    for (int b = 0; b < tree.buckets[n.street]; b++) {
      tr.current(i, b, p);
      for (int a = 0; a < n.nact; a++) buf[size_t(b) * n.nact + a] += float(p[a]);
    }
    if (::pwrite(fd, buf.data(), len * 4, off) != ssize_t(len * 4)) return std::fclose(f), *err = "write failed", false;
  }
  count++;
  bool ok = ::pwrite(fd, &count, 8, 24) == 8 && ::fsync(fd) == 0;
  ok = std::fclose(f) == 0 && ok;
  if (!ok) *err = "could not finish " + path;
  return ok;
}

// Blueprint policy of a compact trainer: running average on its average
// streets; snapshot average on later streets when `snap` has snapshots, else
// the current strategy.
template <class T>
StrategyFn compact_policy(const T& tr, const SnapshotAverage* snap) {
  return [&tr, snap](uint64_t base, int na, double* out) {
    uint32_t ni = tr.node_of_slot(base);
    const Node& n = tr.tree.nodes[ni];
    int bucket = int((base - n.slot) / uint64_t(n.nact));
    (void)na;
    if (tr.has_average(ni) || !snap || n.street < snap->from || !snap->get(base, n.nact, out)) tr.average(ni, bucket, out);
  };
}
template <class T>
StrategyFn compact_current(const T& tr) {
  return [&tr](uint64_t base, int, double* out) {
    uint32_t ni = tr.node_of_slot(base);
    const Node& n = tr.tree.nodes[ni];
    tr.current(ni, int((base - n.slot) / uint64_t(n.nact)), out);
  };
}

// Dense float policy table (tree slot order), the format bp h2h / br use.
inline std::vector<float> policy_to_table(const BettingTree& tree, const StrategyFn& pol) {
  std::vector<float> out(tree.num_slots, 0.f);
  double p[MAX_ACTIONS];
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    for (int b = 0; b < tree.buckets[n.street]; b++) {
      uint64_t base = n.slot + uint64_t(b) * n.nact;
      pol(base, n.nact, p);
      for (int a = 0; a < n.nact; a++) out[base + a] = float(p[a]);
    }
  }
  return out;
}

// System load average over the last minute (getloadavg), or -1 if unavailable.
inline double load_avg_1m() {
  double l[1];
  return ::getloadavg(l, 1) == 1 ? l[0] : -1.0;
}

}  // namespace bp
