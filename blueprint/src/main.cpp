// ============================================================
// main.cpp: `bp` command-line driver.
//
//   bp gate   --game kuhn|leduc   correctness gate: same MCCFR code, exact
//                                 exploitability via best response
//   bp abs    [abstraction opts]  build + cache the card abstraction
//   bp tree   [tree opts]         print betting-tree size and memory
//   bp bench  [opts]              evaluator / sampler / training throughput
//   bp train  [opts]              hold'em blueprint training with logs,
//                                 checkpoints, snapshots, resume
//   bp h2h    --a X --b Y         head-to-head in the abstract game
//   bp br     --target F          approximate best response (exploitability
//                                 lower bound inside the abstraction)
//   bp export --ckpt F --out G    write the compact policy file for TS
//   bp show   --ckpt F            print the preflop opening strategy
//
// Every hold'em command takes the same tree + abstraction options so it can
// rebuild the exact tree a checkpoint was trained on; a fingerprint of both
// is stored in every checkpoint and checked on load.
// ============================================================
#include <sys/resource.h>

#include <algorithm>
#include <iomanip>
#include <map>
#include <memory>
#include <sstream>

#include "abstraction.h"
#include "eval.h"
#include "export.h"
#include "games.h"
#include "mccfr.h"
#include "tree.h"

using namespace bp;

namespace {

// ---- arguments ----------------------------------------------------------------
struct Args {
  std::map<std::string, std::string> kv;
  std::string get(const std::string& k, const std::string& def = "") const {
    auto it = kv.find(k);
    return it == kv.end() ? def : it->second;
  }
  long long geti(const std::string& k, long long def) const {
    auto it = kv.find(k);
    return it == kv.end() ? def : std::stoll(it->second);
  }
  double getf(const std::string& k, double def) const {
    auto it = kv.find(k);
    return it == kv.end() ? def : std::stod(it->second);
  }
  bool has(const std::string& k) const { return kv.count(k) > 0; }
};

Args parse(int argc, char** argv, int start) {
  Args a;
  for (int i = start; i < argc; i++) {
    std::string k = argv[i];
    if (k.rfind("--", 0) != 0) die("unexpected argument " + k);
    k = k.substr(2);
    if (i + 1 < argc && std::string(argv[i + 1]).rfind("--", 0) != 0) a.kv[k] = argv[++i];
    else a.kv[k] = "1";
  }
  return a;
}

double max_rss_mb() {
  struct rusage ru;
  getrusage(RUSAGE_SELF, &ru);
#ifdef __APPLE__
  return ru.ru_maxrss / 1e6;  // bytes on macOS
#else
  return ru.ru_maxrss / 1e3;  // kilobytes on Linux
#endif
}

// ---- hold'em setup -------------------------------------------------------------
struct Holdem {
  TreeConfig tcfg;
  AbsConfig acfg;
  Abstraction abs;
  BettingTree tree;
  uint64_t hash = 0;
};

TreeConfig tree_from_args(const Args& a) {
  TreeConfig c = holdem_config(a.get("preset", "small"));
  if (a.has("stack")) c.stack = int32_t(a.geti("stack", 10000));
  for (int s = 1; s < 4; s++) {
    if (a.has("bet-fracs")) c.street[s].bet_fracs = parse_fracs(a.get("bet-fracs"));
    if (a.has("raise-fracs")) c.street[s].raise_fracs = parse_fracs(a.get("raise-fracs"));
    if (a.has("max-raises")) c.street[s].max_raises = int(a.geti("max-raises", 2));
  }
  if (a.has("pre-fracs")) c.street[0].bet_fracs = c.street[0].raise_fracs = parse_fracs(a.get("pre-fracs"));
  if (a.has("pre-max-raises")) c.street[0].max_raises = int(a.geti("pre-max-raises", 3));
  if (a.has("bet-fracs") || a.has("raise-fracs") || a.has("max-raises") || a.has("pre-fracs") ||
      a.has("pre-max-raises") || a.has("stack"))
    c.name += "-custom";
  return c;
}

AbsConfig abs_from_args(const Args& a) {
  AbsConfig c;
  c.flop_k = int(a.geti("flop", 50));
  c.turn_k = int(a.geti("turn", 50));
  c.river_k = int(a.geti("river", 50));
  c.bins = int(a.geti("bins", 50));
  c.seed = uint64_t(a.geti("abs-seed", 7));
  c.threads = int(a.geti("threads", 4));
  c.sample_flops = int(a.geti("sample-flops", 300));
  c.sample_turns = int(a.geti("sample-turns", 300));
  c.sample_rivers = int(a.geti("sample-rivers", 2000));
  return c;
}

std::unique_ptr<Holdem> setup_holdem(const Args& a, bool need_abs = true) {
  auto h = std::make_unique<Holdem>();
  h->tcfg = tree_from_args(a);
  h->acfg = abs_from_args(a);
  if (need_abs) h->abs.load_or_build(h->acfg, a.get("cache", "cache"));
  else h->abs.cfg = h->acfg;
  int b[4] = {169, h->acfg.flop_k, h->acfg.turn_k, h->acfg.river_k};
  h->tree.build(h->tcfg, b);
  h->hash = fnv1a(h->tcfg.describe() + "|" + h->acfg.id());
  return h;
}

McfrConfig holdem_mcfr(const Args& a) {
  McfrConfig m;
  m.threads = int(a.geti("threads", 4));
  m.seed = uint64_t(a.geti("seed", 1));
  m.regret_scale = 1.0;  // chips, as in Pluribus
  m.discount_every = a.geti("discount-every", 0);
  m.lcfr_until = a.geti("lcfr-until", 0);
  m.prune_after = a.geti("prune-after", -1);
  m.prune_threshold = int32_t(a.geti("prune-threshold", -300000000));
  m.regret_floor = int32_t(a.geti("regret-floor", -310000000));
  if (m.regret_floor > m.prune_threshold) die("regret floor must be below the prune threshold");
  return m;
}

// Preflop helpers for logs: the 13x13 class index of a named hand.
int class_of(const char* name) {
  static const char* R = "23456789TJQKA";
  int a = int(std::strchr(R, name[0]) - R), b = int(std::strchr(R, name[1]) - R);
  if (a == b) return a * 13 + a;
  int hi = std::max(a, b), lo = std::min(a, b);
  return name[2] == 's' ? hi * 13 + lo : lo * 13 + hi;
}
int class_combos(int cls) {
  int r = cls / 13, c = cls % 13;
  return r == c ? 6 : (r > c ? 4 : 12);
}

template <class T>
std::string root_summary(const T& tr, const BettingTree& tree) {
  const Node& root = tree.nodes[0];
  std::ostringstream o;
  const char* hands[] = {"AA", "KK", "AKs", "T9s", "A5o", "72o"};
  for (const char* h : hands) {
    double p[MAX_ACTIONS];
    tr.average(root.slot + uint64_t(class_of(h)) * root.nact, root.nact, p);
    o << h << "[";
    for (int a = 0; a < root.nact; a++) {
      char buf[32];
      std::snprintf(buf, sizeof buf, "%s%s=%.2f", a ? " " : "", tree.token(root.child + a).c_str(), p[a]);
      o << buf;
    }
    o << "] ";
  }
  return o.str();
}

// Combo-weighted fold / limp / raise frequency of the SB's first action.
template <class T>
void root_freqs(const T& tr, const BettingTree& tree, double out[3]) {
  const Node& root = tree.nodes[0];
  out[0] = out[1] = out[2] = 0;
  for (int cls = 0; cls < 169; cls++) {
    double p[MAX_ACTIONS];
    tr.average(root.slot + uint64_t(cls) * root.nact, root.nact, p);
    double w = class_combos(cls) / 1326.0;
    for (int a = 0; a < root.nact; a++) {
      int k = tree.nodes[root.child + a].act_kind;
      out[k == ACT_FOLD ? 0 : k == ACT_CALL ? 1 : 2] += w * p[a];
    }
  }
}

// Mean L1 distance between two average-strategy tables over all preflop
// infosets (a "how much did the preflop strategy move" indicator).
double preflop_l1(const BettingTree& tree, const std::vector<float>& a, const std::vector<float>& b) {
  double tot = 0;
  size_t cnt = 0;
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION || n.street != 0) continue;
    for (int bk = 0; bk < 169; bk++) {
      double s = 0;
      for (int x = 0; x < n.nact; x++) {
        uint64_t i = n.slot + uint64_t(bk) * n.nact + x;
        s += std::fabs(double(a[i]) - double(b[i]));
      }
      tot += s;
      cnt++;
    }
  }
  return cnt ? tot / double(cnt) : 0;
}

template <class T>
std::vector<float> policy_table(const T& tr, const BettingTree& tree, bool current = false) {
  std::vector<float> pol(tree.num_slots, 0.f);
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    for (int b = 0; b < tree.buckets[n.street]; b++) {
      uint64_t base = n.slot + uint64_t(b) * n.nact;
      double p[MAX_ACTIONS];
      if (current) tr.current(base, n.nact, p);
      else tr.average(base, n.nact, p);
      for (int a = 0; a < n.nact; a++) pol[base + a] = float(p[a]);
    }
  }
  return pol;
}

// ---- gate ----------------------------------------------------------------------
template <class Sampler>
int run_gate(const std::string& game, const TreeConfig& tc, const int* buckets, std::vector<WeightedDeal> deals,
             const Args& a) {
  BettingTree tree;
  tree.build(tc, buckets);
  tree.print_stats(stdout);
  McfrConfig m;
  m.threads = int(a.geti("threads", 1));
  m.seed = uint64_t(a.geti("seed", 1));
  m.regret_scale = a.getf("regret-scale", 10000);
  int64_t iters = a.geti("iters", 200000);
  if (!a.has("no-lcfr")) {
    m.discount_every = a.geti("discount-every", 1000);
    m.lcfr_until = a.geti("lcfr-until", iters / 4);
  }
  m.prune_after = a.geti("prune-after", a.has("no-prune") ? -1 : iters / 10);
  m.prune_threshold = int32_t(a.geti("prune-threshold", -2000000));
  m.regret_floor = int32_t(a.geti("regret-floor", -2100000));
  ExactEval ev(tree, deals);
  Trainer<Sampler> tr(tree, Sampler{}, m);
  StrategyFn avg = [&](uint64_t b, int n, double* o) { tr.average(b, n, o); };
  std::printf("game=%s iters=%lld threads=%d lcfr(every=%lld, until=%lld) prune_after=%lld\n", game.c_str(),
              (long long)iters, m.threads, (long long)m.discount_every, (long long)m.lcfr_until,
              (long long)m.prune_after);
  std::printf("%12s %14s %12s %10s\n", "iteration", "exploitability", "value_p0", "seconds");
  double t0 = now_sec();
  int64_t next_log = 1000;
  FILE* csv = a.has("csv") ? std::fopen(a.get("csv").c_str(), "w") : nullptr;
  if (csv) std::fprintf(csv, "iteration,exploitability,value_p0,seconds\n");
  while (tr.iter < iters) {
    tr.run(std::min(iters, next_log), 1e9, next_log - tr.iter, nullptr);
    double e = ev.exploitability(avg), v = ev.value_p0(avg);
    std::printf("%12lld %14.6f %12.6f %10.2f\n", (long long)tr.iter, e, v, now_sec() - t0);
    if (csv) std::fprintf(csv, "%lld,%.8f,%.8f,%.3f\n", (long long)tr.iter, e, v, now_sec() - t0);
    next_log = std::min(iters, next_log * 2);
    if (next_log <= tr.iter) next_log = iters;
  }
  if (csv) std::fclose(csv);
  if (a.has("export")) {
    std::string extra = "\"iterations\":" + std::to_string(tr.iter) +
                        ",\"exploitability\":" + std::to_string(ev.exploitability(avg));
    auto visited = [&](uint64_t b, int n) {
      for (int x = 0; x < n; x++)
        if (tr.S[b + x] > 0 || tr.R[b + x] != 0) return true;
      return false;
    };
    if (!export_policy(tree, avg, visited, extra, a.get("export"))) die("export failed");
    std::printf("exported %s\n", a.get("export").c_str());
  }
  return 0;
}

int cmd_gate(const Args& a) {
  std::string g = a.get("game", "kuhn");
  if (g == "kuhn") {
    int b[4] = {3, 1, 1, 1};
    return run_gate<KuhnSampler>(g, kuhn_config(), b, KuhnSampler::enumerate(), a);
  }
  if (g == "leduc") {
    int b[4] = {3, 9, 1, 1};
    return run_gate<LeducSampler>(g, leduc_config(), b, LeducSampler::enumerate(), a);
  }
  die("unknown game " + g);
}

// ---- abs / tree ----------------------------------------------------------------
int cmd_abs(const Args& a) {
  auto h = setup_holdem(a, true);
  std::printf("canonical flops %zu, turns %zu; peak RSS %.0f MB\n", h->abs.flop_iso.num_canon(),
              h->abs.turn_iso.num_canon(), max_rss_mb());
  // bucket occupancy (combo-weighted over canonical boards)
  for (int st = 1; st <= 2; st++) {
    const auto& tab = st == 1 ? h->abs.flop_bucket : h->abs.turn_bucket;
    const auto& iso = st == 1 ? h->abs.flop_iso : h->abs.turn_iso;
    int K = st == 1 ? h->acfg.flop_k : h->acfg.turn_k;
    std::vector<double> occ(K, 0);
    double tot = 0;
    for (size_t i = 0; i < tab.size(); i++)
      if (tab[i] != 0xFFFF) occ[tab[i]] += iso.canon_weight[i / NUM_COMBOS], tot += iso.canon_weight[i / NUM_COMBOS];
    double mn = 1, mx = 0;
    for (double o : occ) mn = std::min(mn, o / tot), mx = std::max(mx, o / tot);
    std::printf("%s bucket mass: min %.4f max %.4f (uniform would be %.4f)\n", st == 1 ? "flop" : "turn", mn, mx,
                1.0 / K);
  }
  return 0;
}

int cmd_tree(const Args& a) {
  auto h = setup_holdem(a, false);
  h->tree.print_stats(stdout);
  size_t infosets = 0;
  for (const Node& n : h->tree.nodes)
    if (n.type == DECISION) infosets += h->tree.buckets[n.street];
  double bps = double(Trainer<HoldemSampler>::bytes_per_slot());
  std::printf("  infosets %zu, avg %.2f actions/infoset, %.1f bytes/infoset, training tables %.1f MB\n", infosets,
              double(h->tree.num_slots) / double(infosets), bps * double(h->tree.num_slots) / double(infosets),
              bps * double(h->tree.num_slots) / 1e6);
  return 0;
}

// ---- bench ---------------------------------------------------------------------
int cmd_bench(const Args& a) {
  const EvalTables& T = eval_tables();
  (void)T;
  Rng rng(42);
  // 1) random 7-card evaluations (non-incremental)
  {
    const int N = 20000000;
    std::vector<int> cards(N / 4 * 7 + 7);
    for (size_t i = 0; i < cards.size(); i += 7) {
      uint64_t used = 0;
      for (int j = 0; j < 7; j++) {
        int c;
        do c = int(rng.below(52)); while (used >> c & 1);
        used |= 1ull << c;
        cards[i + j] = c;
      }
    }
    double t0 = now_sec();
    uint64_t chk = 0;
    for (int rep = 0; rep < 4; rep++)
      for (size_t i = 0; i + 7 <= cards.size(); i += 7) chk += eval_n(&cards[i], 7);
    double dt = now_sec() - t0;
    std::printf("eval7 random hands: %.1f M/s (checksum %llu)\n", N / dt / 1e6, (unsigned long long)chk);
  }
  // 2) river EHS for a dealt pair, 3) full hold'em deal (needs abstraction)
  {
    int board[5] = {0, 9, 18, 27, 36}, h0[2] = {50, 51}, h1[2] = {44, 45};
    float e[2];
    double t0 = now_sec();
    const int N = 20000;
    for (int i = 0; i < N; i++) river_ehs_pair(board, h0, h1, e);
    std::printf("river_ehs_pair: %.1f us/call\n", (now_sec() - t0) / N * 1e6);
    float all[NUM_COMBOS];
    t0 = now_sec();
    for (int i = 0; i < 2000; i++) river_ehs_all(board, all);
    std::printf("river_ehs_all: %.1f us/call\n", (now_sec() - t0) / 2000 * 1e6);
  }
  if (a.has("no-train")) return 0;
  auto h = setup_holdem(a, true);
  HoldemSampler smp{&h->abs};
  {
    Deal d;
    double t0 = now_sec();
    const int N = 100000;
    for (int i = 0; i < N; i++) smp.sample(rng, d);
    std::printf("holdem deal + 8 bucket lookups: %.2f us/deal\n", (now_sec() - t0) / N * 1e6);
  }
  h->tree.print_stats(stdout);
  double secs = a.getf("seconds", 10);
  std::vector<int> threads_list;
  for (const auto& s : std::vector<std::string>{"1", "2", "4"})
    if (std::stoi(s) <= a.geti("max-threads", 4)) threads_list.push_back(std::stoi(s));
  for (int th : threads_list) {
    McfrConfig m = holdem_mcfr(a);
    m.threads = th;
    Trainer<HoldemSampler> tr(h->tree, smp, m);
    // warm up so regrets are not all zero (cold tables traverse uniformly)
    tr.run(2000, 1e9, 2000, nullptr);
    int64_t start = tr.iter;
    uint64_t v0 = tr.visits.load();
    double t0 = now_sec();
    tr.run(INT64_MAX, secs, 500 * th, nullptr);
    double dt = now_sec() - t0;
    std::printf("train threads=%d: %.0f iterations/s (%.2f M infoset visits/s) over %.1fs\n", th,
                double(tr.iter - start) / dt, double(tr.visits.load() - v0) / dt / 1e6, dt);
  }
  std::printf("peak RSS %.0f MB\n", max_rss_mb());
  return 0;
}

// ---- train ---------------------------------------------------------------------
int cmd_train(const Args& a) {
  auto h = setup_holdem(a, true);
  h->tree.print_stats(stdout);
  HoldemSampler smp{&h->abs};
  McfrConfig m = holdem_mcfr(a);
  std::string out = a.get("out", "runs/" + h->tcfg.name + "-" + h->acfg.id());
  if (std::system(("mkdir -p '" + out + "/snapshots'").c_str()) != 0) die("cannot create " + out);
  Trainer<HoldemSampler> tr(h->tree, smp, m);
  std::string ckpt = out + "/ckpt.bin";
  if (a.has("resume")) {
    if (tr.load(ckpt, h->hash)) std::printf("resumed from %s at iteration %lld\n", ckpt.c_str(), (long long)tr.iter);
    else std::printf("no compatible checkpoint at %s; starting fresh\n", ckpt.c_str());
  }
  double minutes = a.getf("minutes", 25);
  int64_t max_iters = a.geti("iters", INT64_MAX);
  double log_every = a.getf("log-every-sec", 30);
  double ckpt_every = a.getf("ckpt-every-min", 5) * 60;
  double snap_every = a.getf("snapshot-every-min", 5) * 60;
  FILE* log = std::fopen((out + "/log.csv").c_str(), tr.iter > 0 ? "a" : "w");
  if (tr.iter == 0)
    std::fprintf(log,
                 "iteration,seconds,iters_per_sec,visits_per_sec,avg_pos_regret_mbb,preflop_l1_vs_prev,"
                 "sb_fold,sb_limp,sb_raise,pruned_frac\n");
  std::printf("training %s for %.1f min, %d threads, lcfr every %lld until %lld, prune after %lld -> %s\n",
              h->tcfg.name.c_str(), minutes, m.threads, (long long)m.discount_every, (long long)m.lcfr_until,
              (long long)m.prune_after, out.c_str());
  double t0 = now_sec(), t_end = t0 + minutes * 60;
  double last_log = t0, last_ckpt = t0, last_snap = t0;
  int64_t last_iter = tr.iter;
  uint64_t last_vis = 0, last_ex = 0, last_pr = 0;
  int64_t chunk = 200 * m.threads;
  std::vector<float> prev_pol = policy_table(tr, h->tree);
  while (now_sec() < t_end && tr.iter < max_iters) {
    double c0 = now_sec();
    tr.run(std::min(max_iters, tr.iter + chunk), t_end - c0, chunk, nullptr);
    double cdt = now_sec() - c0;
    // aim for ~1 s chunks so logs and the deadline stay responsive
    if (cdt > 0) chunk = std::max<int64_t>(m.threads, int64_t(double(chunk) / cdt));
    double t = now_sec();
    bool final_round = t >= t_end || tr.iter >= max_iters;
    if (t - last_log >= log_every || final_round) {
      double dt = t - last_log;
      std::vector<float> pol = policy_table(tr, h->tree);
      double l1 = preflop_l1(h->tree, pol, prev_pol);
      prev_pol.swap(pol);
      double fr[3];
      root_freqs(tr, h->tree, fr);
      double reg = tr.avg_positive_regret() * 10.0;  // chips -> mbb (BB = 100 chips)
      double ips = double(tr.iter - last_iter) / dt, vps = double(tr.visits.load() - last_vis) / dt;
      // share of traverser actions skipped by pruning since the last log
      uint64_t ex = tr.explored.load(), pr = tr.pruned.load();
      double pfrac = (ex + pr - last_ex - last_pr) ? double(pr - last_pr) / double(ex + pr - last_ex - last_pr) : 0;
      last_ex = ex, last_pr = pr;
      std::fprintf(log, "%lld,%.1f,%.1f,%.0f,%.4f,%.5f,%.4f,%.4f,%.4f,%.4f\n", (long long)tr.iter, t - t0, ips, vps,
                   reg, l1, fr[0], fr[1], fr[2], pfrac);
      std::fflush(log);
      std::printf("[%6.0fs] it=%lld  %.0f it/s  sum avg+regret=%.1f mbb  preflopL1=%.4f  SB fold/limp/raise=%.3f/%.3f/%.3f  pruned=%.3f\n",
                  t - t0, (long long)tr.iter, ips, reg, l1, fr[0], fr[1], fr[2], pfrac);
      std::printf("          %s\n", root_summary(tr, h->tree).c_str());
      std::fflush(stdout);
      last_log = t;
      last_iter = tr.iter;
      last_vis = tr.visits.load();
    }
    if (t - last_ckpt >= ckpt_every || final_round) {
      if (!tr.save(ckpt, h->hash)) die("checkpoint failed");
      last_ckpt = t;
    }
    if (t - last_snap >= snap_every || final_round) {
      char p[512];
      std::snprintf(p, sizeof p, "%s/snapshots/it%012lld.bin", out.c_str(), (long long)tr.iter);
      if (!tr.save(p, h->hash)) die("snapshot failed");
      last_snap = t;
    }
  }
  std::fclose(log);
  std::printf("done: %lld iterations in %.1fs; peak RSS %.0f MB; checkpoint %s\n", (long long)tr.iter, now_sec() - t0,
              max_rss_mb(), ckpt.c_str());
  return 0;
}

// ---- head-to-head ---------------------------------------------------------------
enum AgentKind { AG_POLICY, AG_CHECKCALL, AG_RANDOM, AG_MANIAC };
struct Agent {
  AgentKind kind = AG_RANDOM;
  std::vector<float> pol;
  std::string name;
  int act(const BettingTree& tree, const Node& n, const Deal& d, Rng& rng) const {
    switch (kind) {
      case AG_CHECKCALL:
        for (int a = 0; a < n.nact; a++) {
          int k = tree.nodes[n.child + a].act_kind;
          if (k == ACT_CHECK || k == ACT_CALL) return a;
        }
        return 0;
      case AG_RANDOM: return int(rng.below(n.nact));
      case AG_MANIAC: return n.nact - 1;  // largest bet / all-in, else call
      case AG_POLICY: {
        const float* p = &pol[n.slot + uint64_t(d.bucket[n.player][n.street]) * n.nact];
        double r = rng.uniform(), acc = 0;
        for (int a = 0; a < n.nact; a++) {
          acc += p[a];
          if (r < acc) return a;
        }
        return n.nact - 1;
      }
    }
    return 0;
  }
};

Agent make_agent(const std::string& spec, Holdem& h) {
  Agent ag;
  ag.name = spec;
  if (spec == "checkcall") ag.kind = AG_CHECKCALL;
  else if (spec == "random") ag.kind = AG_RANDOM;
  else if (spec == "maniac") ag.kind = AG_MANIAC;
  else {
    ag.kind = AG_POLICY;
    McfrConfig m;
    Trainer<HoldemSampler> tr(h.tree, HoldemSampler{&h.abs}, m);
    if (!tr.load(spec, h.hash)) die("cannot load checkpoint " + spec + " for this tree/abstraction");
    ag.pol = policy_table(tr, h.tree);
    std::printf("loaded %s (iteration %lld)\n", spec.c_str(), (long long)tr.iter);
  }
  return ag;
}

struct H2HResult {
  double mbb, ci95;
};

H2HResult play_h2h(Holdem* h, const Agent& A, const Agent& B, int64_t hands, int threads, uint64_t seed) {
  HoldemSampler smp{&h->abs};
  // Duplicate format: every deal is played twice with seats swapped, so card
  // luck cancels; the sample unit is the seat-averaged result of one deal.
  std::vector<double> sum(threads, 0), sq(threads, 0);
  std::vector<std::thread> pool;
  for (int t = 0; t < threads; t++)
    pool.emplace_back([&, t] {
      Rng rng(seed * 1000 + uint64_t(t));
      Deal d;
      int64_t n = hands / threads + (t < hands % threads ? 1 : 0);
      for (int64_t i = 0; i < n; i++) {
        smp.sample(rng, d);
        double r = 0;
        for (int seat = 0; seat < 2; seat++) {
          uint32_t ni = 0;
          while (h->tree.nodes[ni].type == DECISION) {
            const Node& nd = h->tree.nodes[ni];
            const Agent& who = nd.player == seat ? A : B;
            ni = nd.child + who.act(h->tree, nd, d, rng);
          }
          r += terminal_utility(h->tree.nodes[ni], seat, d.winner);
        }
        r *= 0.5;
        sum[t] += r;
        sq[t] += r * r;
      }
    });
  for (auto& th : pool) th.join();
  double S = 0, Q = 0;
  for (int t = 0; t < threads; t++) S += sum[t], Q += sq[t];
  double mean = S / hands, var = Q / hands - mean * mean;
  double ci = 1.96 * std::sqrt(var / hands);
  // chips -> milli-big-blinds: 1 chip = 1/100 BB = 10 mbb
  return {mean * 10, ci * 10};
}

int cmd_h2h(const Args& a) {
  auto h = setup_holdem(a, true);
  Agent A = make_agent(a.get("a"), *h), B = make_agent(a.get("b", "checkcall"), *h);
  int64_t hands = a.geti("hands", 200000);
  H2HResult r = play_h2h(h.get(), A, B, hands, int(a.geti("threads", 4)), uint64_t(a.geti("seed", 99)));
  std::printf("h2h %s vs %s: %+.1f mbb/hand  (95%% CI +/- %.1f, %lld duplicate deals = %lld hands)\n",
              A.name.c_str(), B.name.c_str(), r.mbb, r.ci95, (long long)hands, (long long)hands * 2);
  return 0;
}

// ---- approximate best response ------------------------------------------------------
// Freeze the target policy, train an exploiter with the same MCCFR code where
// the opponent's nodes always play the target (Trainer::fixed), then score the
// exploiter against the target in duplicate head-to-head. The result lower-
// bounds the target's exploitability in the abstract game: a true best
// response would also see the full card information, not just buckets, and
// would be exact rather than sampled.
int cmd_br(const Args& a) {
  auto h = setup_holdem(a, true);
  Agent target = make_agent(a.get("target"), *h);
  McfrConfig m = holdem_mcfr(a);
  Trainer<HoldemSampler> ex(h->tree, HoldemSampler{&h->abs}, m);
  ex.fixed = &target.pol;
  double minutes = a.getf("minutes", 3);
  double t0 = now_sec();
  int64_t chunk = 1000 * m.threads;
  while (now_sec() - t0 < minutes * 60) {
    double c0 = now_sec();
    ex.run(ex.iter + chunk, minutes * 60 - (c0 - t0), chunk, nullptr);
    double cdt = now_sec() - c0;
    if (cdt > 0) chunk = std::max<int64_t>(m.threads, int64_t(double(chunk) * 2.0 / cdt));
  }
  std::printf("exploiter trained %lld iterations in %.0fs against %s\n", (long long)ex.iter, now_sec() - t0,
              target.name.c_str());
  int64_t hands = a.geti("hands", 300000);
  // In best-response mode nothing is averaged (the opponent's nodes are
  // frozen), so the exploiter is read off its regrets: the current
  // regret-matching strategy, and the greedy policy that puts all mass on the
  // highest-regret action (a pure best-response estimate).
  for (int greedy = 0; greedy < 2; greedy++) {
    Agent E;
    E.kind = AG_POLICY;
    E.name = greedy ? "exploiter(greedy)" : "exploiter(current)";
    E.pol = policy_table(ex, h->tree, true);
    if (greedy) {
      for (const Node& n : h->tree.nodes) {
        if (n.type != DECISION) continue;
        for (int b = 0; b < h->tree.buckets[n.street]; b++) {
          uint64_t base = n.slot + uint64_t(b) * n.nact;
          int best = 0;
          for (int x = 1; x < n.nact; x++)
            if (ex.R[base + x] > ex.R[base + best]) best = x;
          if (ex.R[base + best] <= 0) continue;  // untouched infoset: keep uniform
          for (int x = 0; x < n.nact; x++) E.pol[base + x] = x == best ? 1.f : 0.f;
        }
      }
    }
    H2HResult r = play_h2h(h.get(), E, target, hands, m.threads, uint64_t(a.geti("seed", 99)));
    std::printf("%s vs %s: %+.1f mbb/hand (95%% CI +/- %.1f, %lld duplicate deals)\n", E.name.c_str(),
                target.name.c_str(), r.mbb, r.ci95, (long long)hands);
  }
  if (a.has("out") && !ex.save(a.get("out"), h->hash)) die("cannot save exploiter");
  return 0;
}

// ---- export / show ---------------------------------------------------------------
int cmd_export(const Args& a) {
  auto h = setup_holdem(a, true);
  McfrConfig m;
  Trainer<HoldemSampler> tr(h->tree, HoldemSampler{&h->abs}, m);
  std::string ck = a.get("ckpt");
  if (!tr.load(ck, h->hash)) die("cannot load checkpoint " + ck);
  std::ostringstream ex;
  ex << "\"iterations\":" << tr.iter << ",\"abstraction\":{\"id\":\"" << h->acfg.id()
     << "\",\"preflop\":\"169 classes: pair r*13+r, suited hi*13+lo, offsuit lo*13+hi (ranks 0..12 = 2..A)\""
     << ",\"flop\":\"k-means on river-EHS histograms (CDF, L2)\",\"turn\":\"k-means on river-EHS histograms (CDF, L2)\""
     << ",\"river\":\"1-D k-means on EHS; bucket = number of river_bounds below EHS\",\"river_bounds\":[";
  ex << std::setprecision(9);  // float32 round-trips exactly at 9 significant digits
  for (size_t i = 0; i < h->abs.river_bounds.size(); i++) ex << (i ? "," : "") << h->abs.river_bounds[i];
  ex << "]}";
  StrategyFn avg = [&](uint64_t b, int n, double* o) { tr.average(b, n, o); };
  auto visited = [&](uint64_t b, int n) {
    for (int x = 0; x < n; x++)
      if (tr.S[b + x] > 0 || tr.R[b + x] != 0) return true;
    return false;
  };
  std::string out = a.get("out", "blueprint.gpobp");
  if (!export_policy(h->tree, avg, visited, ex.str(), out)) die("export failed");
  FILE* f = std::fopen(out.c_str(), "rb");
  std::fseek(f, 0, SEEK_END);
  long sz = std::ftell(f);
  std::fclose(f);
  std::printf("exported %s (%.2f MB, %zu nodes, %llu strategy bytes)\n", out.c_str(), sz / 1e6, h->tree.nodes.size(),
              (unsigned long long)h->tree.num_slots);
  return 0;
}

int cmd_show(const Args& a) {
  auto h = setup_holdem(a, true);
  McfrConfig m;
  Trainer<HoldemSampler> tr(h->tree, HoldemSampler{&h->abs}, m);
  if (!tr.load(a.get("ckpt"), h->hash)) die("cannot load checkpoint");
  std::vector<std::string> toks;
  std::stringstream ss(a.get("history", ""));
  std::string t;
  while (ss >> t) toks.push_back(t);
  int64_t ni = h->tree.find(toks);
  if (ni < 0 || h->tree.nodes[ni].type != DECISION) die("history not found or terminal");
  const Node& n = h->tree.nodes[ni];
  std::printf("node %lld street %d player %d history '%s' (iteration %lld)\n", (long long)ni, n.street, n.player,
              h->tree.history(uint32_t(ni)).c_str(), (long long)tr.iter);
  if (n.street == 0) {
    // 13x13 grid: probability of any bet/raise/all-in
    static const char* R = "23456789TJQKA";
    std::printf("aggression probability, rows/cols A..2 (upper-right suited, lower-left offsuit)\n     ");
    for (int c = 12; c >= 0; c--) std::printf("   %c ", R[c]);
    std::printf("\n");
    for (int r = 12; r >= 0; r--) {
      std::printf("  %c  ", R[r]);
      for (int c = 12; c >= 0; c--) {
        // With ranks descending on both axes, c < r is upper-right (suited,
        // hi = r) and c > r is lower-left (offsuit, lo = r): both are r*13+c.
        int cls = r * 13 + c;
        double p[MAX_ACTIONS];
        tr.average(n.slot + uint64_t(cls) * n.nact, n.nact, p);
        double agg = 0;
        for (int x = 0; x < n.nact; x++) {
          int k = h->tree.nodes[n.child + x].act_kind;
          if (k == ACT_BET || k == ACT_RAISE || k == ACT_ALLIN) agg += p[x];
        }
        std::printf(" %.2f", agg);
      }
      std::printf("\n");
    }
  } else {
    for (int b = 0; b < h->tree.buckets[n.street]; b++) {
      double p[MAX_ACTIONS];
      tr.average(n.slot + uint64_t(b) * n.nact, n.nact, p);
      std::printf("bucket %3d:", b);
      for (int x = 0; x < n.nact; x++) std::printf(" %s=%.2f", h->tree.token(n.child + x).c_str(), p[x]);
      std::printf("\n");
    }
  }
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: bp <gate|abs|tree|bench|train|h2h|br|export|show> [--options]\n"
                         "see blueprint/README.md\n");
    return 2;
  }
  std::string cmd = argv[1];
  Args a = parse(argc, argv, 2);
  if (cmd == "gate") return cmd_gate(a);
  if (cmd == "abs") return cmd_abs(a);
  if (cmd == "tree") return cmd_tree(a);
  if (cmd == "bench") return cmd_bench(a);
  if (cmd == "train") return cmd_train(a);
  if (cmd == "h2h") return cmd_h2h(a);
  if (cmd == "br") return cmd_br(a);
  if (cmd == "export") return cmd_export(a);
  if (cmd == "show") return cmd_show(a);
  die("unknown command " + cmd);
}
