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
#include <dirent.h>
#include <sys/resource.h>
#include <sys/stat.h>

#include <ctime>

#include <csignal>

#include <algorithm>
#include <iomanip>
#include <map>
#include <memory>
#include <sstream>

#include "abstraction.h"
#include "compact.h"  // PLAN.md M3: bp scale
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

bool file_exists(const std::string& p) {
  struct stat st;
  return ::stat(p.c_str(), &st) == 0;
}

std::vector<std::string> list_dir(const std::string& dir, const std::string& suffix) {
  std::vector<std::string> out;
  DIR* d = ::opendir(dir.c_str());
  if (!d) return out;
  while (struct dirent* e = ::readdir(d)) {
    std::string n = e->d_name;
    if (n.size() > suffix.size() && n.compare(n.size() - suffix.size(), suffix.size(), suffix) == 0) out.push_back(n);
  }
  ::closedir(d);
  return out;
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
  print_layout(h->tree, 1, stdout);  // PLAN.md M3: compact layout (bp scale), 4 B per postflop slot
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
  // --threads-list 1,16,48,96,192 picks the thread counts explicitly (cloud bench);
  // otherwise 1, 2 and 4 threads up to --max-threads, as before.
  std::vector<int> threads_list;
  // Both spellings are accepted: --threads-list (cloud bench.sh) and --thread-list
  // (the overnight script), e.g. --threads-list 1,16,48,96,192.
  const char* tl_key = a.has("threads-list") ? "threads-list" : (a.has("thread-list") ? "thread-list" : nullptr);
  if (tl_key) {
    std::stringstream ss(a.get(tl_key));
    std::string tok;
    while (std::getline(ss, tok, ','))
      if (!tok.empty()) threads_list.push_back(std::stoi(tok));
    if (threads_list.empty()) die("empty --threads-list");
  } else {
    for (const auto& s : std::vector<std::string>{"1", "2", "4"})
      if (std::stoi(s) <= a.geti("max-threads", 4)) threads_list.push_back(std::stoi(s));
  }
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
// SIGTERM / SIGINT ask a running `bp train` to stop after the current ~1 s chunk,
// write its checkpoint and snapshot, and exit with status 75 (EX_TEMPFAIL), so a
// spot-interruption notice or `systemctl stop` loses at most one chunk of work.
volatile std::sig_atomic_t g_stop_signal = 0;
extern "C" void on_stop_signal(int sig) { g_stop_signal = sig; }

int cmd_train(const Args& a) {
  std::signal(SIGTERM, on_stop_signal);
  std::signal(SIGINT, on_stop_signal);
  auto h = setup_holdem(a, true);
  h->tree.print_stats(stdout);
  HoldemSampler smp{&h->abs};
  McfrConfig m = holdem_mcfr(a);
  std::string out = a.get("out", "runs/" + h->tcfg.name + "-" + h->acfg.id());
  if (std::system(("mkdir -p '" + out + "/snapshots'").c_str()) != 0) die("cannot create " + out);
  Trainer<HoldemSampler> tr(h->tree, smp, m);
  std::string ckpt = out + "/ckpt.bin";
  if (a.has("resume")) {
    // Try ckpt.bin, then snapshots newest first (names sort by iteration).
    // If any candidate file exists but none loads, refuse to start: starting
    // fresh would overwrite hours of training with an empty table.
    std::vector<std::string> cands;
    if (file_exists(ckpt)) cands.push_back(ckpt);
    std::vector<std::string> snaps = list_dir(out + "/snapshots", ".bin");
    std::sort(snaps.rbegin(), snaps.rend());
    for (auto& s : snaps) cands.push_back(out + "/snapshots/" + s);
    bool loaded = false;
    for (auto& c : cands) {
      if (tr.load(c, h->hash)) {
        std::printf("resumed from %s at iteration %lld\n", c.c_str(), (long long)tr.iter);
        loaded = true;
        break;
      }
      std::printf("could not load %s (wrong tree/abstraction or damaged); trying the next one\n", c.c_str());
    }
    if (!loaded && !cands.empty()) die("--resume: checkpoint files exist under " + out + " but none loads");
    if (!loaded) std::printf("no checkpoint under %s; starting fresh\n", out.c_str());
  }
  double minutes = a.getf("minutes", 25);
  // --until-epoch T: stop at Unix time T at the latest (a fixed deadline that
  // survives restarts, unlike --minutes, which counts from process start).
  if (a.has("until-epoch")) {
    double left = (double(a.geti("until-epoch", 0)) - double(std::time(nullptr))) / 60.0;
    if (left <= 0) {
      std::printf("deadline already passed; nothing to do\n");
      return 0;
    }
    minutes = std::min(minutes, left);
  }
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
  while (now_sec() < t_end && tr.iter < max_iters && !g_stop_signal) {
    double c0 = now_sec();
    tr.run(std::min(max_iters, tr.iter + chunk), t_end - c0, chunk, nullptr);
    double cdt = now_sec() - c0;
    // aim for ~1 s chunks so logs and the deadline stay responsive
    if (cdt > 0) chunk = std::max<int64_t>(m.threads, int64_t(double(chunk) / cdt));
    double t = now_sec();
    bool final_round = t >= t_end || tr.iter >= max_iters || g_stop_signal;
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
  if (g_stop_signal) {
    std::printf("stopped by signal %d after writing the checkpoint; rerun with --resume\n", int(g_stop_signal));
    return 75;
  }
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

// ---- PLAN.md M3: bp scale (compact trainer, src/compact.h) -------------------------
//
//   bp scale gate  --game kuhn|leduc   dense average vs preflop average + later-street
//                                      snapshot average, exact exploitability (ExactEval)
//   bp scale verify [tree opts]        dense vs compact on hold'em, 1 thread, same seed:
//                                      regrets and preflop sums must be identical
//   bp scale tree  [tree opts]         layout bytes per street; --probe-seconds S trains
//                                      the lazy trainer for S s and reports what it
//                                      allocated; --v1-ckpt F counts the blocks a dense
//                                      checkpoint has touched (what lazy would allocate)
//   bp scale bench [tree opts]         threads scaling, --threads-list 1,2,4,8
//                                      --seconds 20 --max-load 14; CSV for cost.py
//   bp scale train [tree opts]         hold'em training with the compact trainer;
//                                      checkpoints and snapshots in format GPOCKPT2
//   bp scale export --ckpt F           blueprint file from a compact checkpoint plus
//                                      the snapshot average (--snap-accum FILE, or
//                                      the checkpoints in --snapshots DIR)
using CompactHoldem = CompactTrainer<HoldemSampler>;

int scale_gate(const Args& a) {
  std::string game = a.get("game", "leduc");
  if (game != "kuhn" && game != "leduc") die("scale gate: --game kuhn|leduc");
  bool leduc = game == "leduc";
  int kb[4] = {3, 1, 1, 1}, lb[4] = {3, 9, 1, 1};
  BettingTree tree;
  tree.build(leduc ? leduc_config() : kuhn_config(), leduc ? lb : kb);
  int64_t iters = a.geti("iters", 4000000);
  // Same schedule as `bp gate` (run_gate above).
  McfrConfig m;
  m.threads = int(a.geti("threads", 1));
  m.seed = uint64_t(a.geti("seed", 1));
  m.regret_scale = a.getf("regret-scale", 10000);
  m.discount_every = a.geti("discount-every", 1000);
  m.lcfr_until = a.geti("lcfr-until", iters / 4);
  m.prune_after = a.geti("prune-after", iters / 10);
  m.prune_threshold = int32_t(a.geti("prune-threshold", -2000000));
  m.regret_floor = int32_t(a.geti("regret-floor", -2100000));
  int avg_streets = int(a.geti("avg-streets", 1));
  int64_t snap_start = int64_t(a.getf("snap-start-frac", 0.25) * double(iters));
  // Defaults: 751 snapshots over the last 75% (README "Compact trainer": the
  // gate needs hundreds of snapshots; 55 at Pluribus's schedule fractions miss it).
  int64_t snap_every = std::max<int64_t>(1, int64_t(a.getf("snap-every-frac", 0.001) * double(iters)));
  std::vector<WeightedDeal> deals = leduc ? LeducSampler::enumerate() : KuhnSampler::enumerate();
  ExactEval ev(tree, deals);
  std::printf("scale gate %s: %lld iterations, %d threads, lcfr every %lld until %lld, prune after %lld; "
              "average on streets < %d, snapshots every %lld from %lld\n",
              game.c_str(), (long long)iters, m.threads, (long long)m.discount_every, (long long)m.lcfr_until,
              (long long)m.prune_after, avg_streets, (long long)snap_every, (long long)snap_start);
  double t0 = now_sec();
  double e_dense = -1;
  if (!a.has("no-dense")) {
    auto run_dense = [&](auto sampler) {
      Trainer<decltype(sampler)> d(tree, sampler, m);
      d.run(iters, 1e9, 100000, nullptr);
      StrategyFn f = [&](uint64_t b, int n, double* o) { d.average(b, n, o); };
      return ev.exploitability(f);
    };
    e_dense = leduc ? run_dense(LeducSampler{}) : run_dense(KuhnSampler{});
    std::printf("dense average (bp gate):            exploitability %.6f  (%.1fs)\n", e_dense, now_sec() - t0);
  }
  double t1 = now_sec();
  double e_snap = 0, e_cur = 0, e_avg_only = 0;
  int64_t nsnap = 0;
  uint64_t tbytes = 0;
  auto run_compact = [&](auto sampler) {
    CompactTrainer<decltype(sampler)> c(tree, sampler, m, avg_streets, true);
    SnapshotAverage snap(tree, avg_streets);
    while (c.iter < iters) {
      int64_t next = c.iter < snap_start ? snap_start : c.iter + snap_every;
      c.run(std::min(iters, next), 1e9, std::min<int64_t>(100000, snap_every), nullptr);
      if (c.iter >= snap_start) snap.add(c);
    }
    e_snap = ev.exploitability(compact_policy(c, &snap));
    e_cur = ev.exploitability(compact_current(c));
    e_avg_only = ev.exploitability(compact_policy(c, nullptr));
    nsnap = snap.count;
    tbytes = c.table_bytes();
  };
  if (leduc) run_compact(LeducSampler{});
  else run_compact(KuhnSampler{});
  LayoutBytes L = layout_bytes(tree, avg_streets);
  std::printf("compact: running average + %lld snapshots: exploitability %.6f  (%.1fs)\n", (long long)nsnap, e_snap,
              now_sec() - t1);
  std::printf("compact: running average + current:     exploitability %.6f\n", e_avg_only);
  std::printf("compact: current strategy everywhere:   exploitability %.6f\n", e_cur);
  std::printf("tables: compact %llu B (trained), dense %llu B\n", (unsigned long long)tbytes,
              (unsigned long long)L.dense);
  if (e_dense >= 0) {
    double ratio = e_snap / e_dense;
    std::printf("ratio snapshot/dense = %.3f -> %s (PLAN.md M3 gate: within 2x)\n", ratio,
                ratio <= 2.0 ? "PASS" : "FAIL");
    if (a.has("csv")) {
      FILE* f = std::fopen(a.get("csv").c_str(), "w");
      if (f) {
        std::fprintf(f, "game,iterations,threads,snap_start,snap_every,snapshots,dense,snapshot,avg_plus_current,current\n");
        std::fprintf(f, "%s,%lld,%d,%lld,%lld,%lld,%.8f,%.8f,%.8f,%.8f\n", game.c_str(), (long long)iters, m.threads,
                     (long long)snap_start, (long long)snap_every, (long long)nsnap, e_dense, e_snap, e_avg_only, e_cur);
        std::fclose(f);
      }
    }
    return ratio <= 2.0 ? 0 : 2;
  }
  return 0;
}

int scale_tree(const Args& a) {
  int avg_streets = int(a.geti("avg-streets", 1));
  bool probe = a.has("probe-seconds") || a.has("probe-iters");
  auto h = setup_holdem(a, probe);
  const BettingTree& t = h->tree;
  t.print_stats(stdout);
  LayoutBytes L = layout_bytes(t, avg_streets);
  std::printf("layout                 bytes/slot pre/flop/turn/river   tables\n");
  std::printf("dense (bp train)       12/12/12/12                      %10.1f MB\n", L.dense / 1e6);
  std::printf("compact (bp scale)     ");
  for (int s = 0; s < 4; s++) std::printf("%s%d", s ? "/" : "", s < avg_streets ? 12 : 4);
  std::printf("                        %10.1f MB (+%.2f MB node index), all blocks allocated\n",
              (L.compact_full - L.index_bytes) / 1e6, L.index_bytes / 1e6);
  if (a.has("v1-ckpt")) {
    // Read a dense checkpoint (GPOCKPT1: magic, hash, iter, weight, ns, R[ns] i32, S[ns] f64)
    // and count, per street, the node blocks with any nonzero regret or sum.
    std::string path = a.get("v1-ckpt");
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) die("cannot open " + path);
    char magic[8];
    uint64_t hh, ns;
    int64_t it;
    double w;
    if (std::fread(magic, 1, 8, f) != 8 || std::memcmp(magic, "GPOCKPT1", 8) != 0) die("not a GPOCKPT1 file");
    if (std::fread(&hh, 8, 1, f) != 1 || std::fread(&it, 8, 1, f) != 1 || std::fread(&w, 8, 1, f) != 1 ||
        std::fread(&ns, 8, 1, f) != 1)
      die("truncated header");
    if (hh != h->hash || ns != t.num_slots) die("checkpoint was trained on a different tree/abstraction");
    std::vector<int32_t> R(ns);
    std::vector<double> S(ns);
    if (std::fread(R.data(), 4, ns, f) != ns || std::fread(S.data(), 8, ns, f) != ns) die("truncated tables");
    std::fclose(f);
    uint64_t nodes[4] = {0}, touched[4] = {0}, slots[4] = {0}, tslots[4] = {0};
    for (const Node& n : t.nodes) {
      if (n.type != DECISION) continue;
      uint64_t len = uint64_t(t.buckets[n.street]) * n.nact;
      bool any = false;
      for (uint64_t k = n.slot; k < n.slot + len && !any; k++) any = R[k] != 0 || S[k] != 0;
      nodes[n.street]++, slots[n.street] += len;
      if (any) touched[n.street]++, tslots[n.street] += len;
    }
    uint64_t used = 0;
    std::printf("dense checkpoint %s at iteration %lld: node blocks touched per street\n", path.c_str(), (long long)it);
    for (int s = 0; s < t.cfg.nstreets; s++) {
      std::printf("  street %d: %llu of %llu nodes (%.1f%%), %llu of %llu slots\n", s, (unsigned long long)touched[s],
                  (unsigned long long)nodes[s], 100.0 * touched[s] / std::max<uint64_t>(1, nodes[s]),
                  (unsigned long long)tslots[s], (unsigned long long)slots[s]);
      used += s < avg_streets ? slots[s] * 12 : tslots[s] * 4;
    }
    std::printf("compact tables for the touched blocks: %.1f MB (+%.2f MB node index) vs dense %.1f MB\n", used / 1e6,
                L.index_bytes / 1e6, L.dense / 1e6);
  }
  if (probe) {
    McfrConfig m = holdem_mcfr(a);
    CompactHoldem tr(t, HoldemSampler{&h->abs}, m, avg_streets, true);
    double secs = a.getf("probe-seconds", 1e9);
    int64_t iters = a.geti("probe-iters", INT64_MAX);
    double t0 = now_sec();
    tr.run(iters, secs, 500 * std::max(1, m.threads), nullptr);
    std::printf("lazy probe: %lld iterations in %.1fs, %d threads\n", (long long)tr.iter, now_sec() - t0, m.threads);
    uint64_t nodes[4] = {0}, alloc[4] = {0};
    for (uint32_t i : tr.decision_nodes()) {
      int s = t.nodes[i].street;
      nodes[s]++;
      alloc[s] += tr.block(i) != nullptr;
    }
    for (int s = 0; s < t.cfg.nstreets; s++)
      std::printf("  street %d: %llu of %llu node blocks allocated (%.1f%%), %llu slots\n", s,
                  (unsigned long long)alloc[s], (unsigned long long)nodes[s],
                  100.0 * alloc[s] / std::max<uint64_t>(1, nodes[s]),
                  (unsigned long long)tr.allocated_slots_on_street(s));
    std::printf("  real tables: regrets %.2f MB (arena reserved %.2f MB) + average %.2f MB + index %.2f MB = %.2f MB; "
                "peak RSS %.0f MB (includes the abstraction tables)\n",
                tr.regret_bytes() / 1e6, tr.regret_reserved_bytes() / 1e6, tr.avg_bytes() / 1e6,
                tr.index_bytes() / 1e6, tr.table_bytes() / 1e6, max_rss_mb());
  }
  return 0;
}

int scale_bench(const Args& a) {
  auto h = setup_holdem(a, true);
  HoldemSampler smp{&h->abs};
  h->tree.print_stats(stdout);
  double secs = a.getf("seconds", 20);
  double max_load = a.getf("max-load", 14);
  double max_wait = a.getf("max-wait-sec", 600);
  int avg_streets = int(a.geti("avg-streets", 1));
  std::vector<int> threads_list;
  {
    std::stringstream ss(a.get("threads-list", "1,2,4,8"));
    std::string tok;
    while (std::getline(ss, tok, ','))
      if (!tok.empty()) threads_list.push_back(std::stoi(tok));
  }
  std::vector<std::string> kinds;
  if (!a.has("dense-only")) kinds.push_back("compact");
  if (a.has("dense") || a.has("dense-only")) kinds.push_back("dense");
  FILE* csv = a.has("csv") ? std::fopen(a.get("csv").c_str(), "w") : nullptr;
  if (csv) std::fprintf(csv, "threads,iters_per_sec,visits_per_sec,seconds,trainer,load_before,load_after,table_mb\n");
  for (int th : threads_list)
    for (const std::string& kind : kinds) {
      double waited = 0, load = load_avg_1m();
      while (load > max_load && waited < max_wait) {
        std::printf("load average %.2f > %.1f; waiting\n", load, max_load);
        std::fflush(stdout);
        ::sleep(15);
        waited += 15;
        load = load_avg_1m();
      }
      if (load > max_load) {
        std::printf("skip threads=%d %s: load average %.2f still above %.1f\n", th, kind.c_str(), load, max_load);
        continue;
      }
      McfrConfig m = holdem_mcfr(a);
      m.threads = th;
      double ips = 0, vps = 0, dt = 0, mb = 0;
      auto measure = [&](auto& tr) {
        tr.run(2000, 1e9, 2000, nullptr);  // warm-up, as in bp bench
        int64_t start = tr.iter;
        uint64_t v0 = tr.visits.load();
        double t0 = now_sec();
        tr.run(INT64_MAX, secs, 500 * th, nullptr);
        dt = now_sec() - t0;
        ips = double(tr.iter - start) / dt;
        vps = double(tr.visits.load() - v0) / dt;
      };
      if (kind == "compact") {
        CompactHoldem tr(h->tree, smp, m, avg_streets, true);
        measure(tr);
        mb = tr.table_bytes() / 1e6;
      } else {
        Trainer<HoldemSampler> tr(h->tree, smp, m);
        measure(tr);
        mb = h->tree.num_slots * 12.0 / 1e6;
      }
      double load_after = load_avg_1m();
      std::printf("%-7s threads=%d: %.0f iterations/s, %.2f M infoset visits/s over %.1fs; load %.2f -> %.2f; "
                  "tables %.1f MB\n",
                  kind.c_str(), th, ips, vps / 1e6, dt, load, load_after, mb);
      std::fflush(stdout);
      if (csv) {
        std::fprintf(csv, "%d,%.0f,%.0f,%.1f,%s,%.2f,%.2f,%.2f\n", th, ips, vps, dt, kind.c_str(), load, load_after, mb);
        std::fflush(csv);
      }
    }
  if (csv) std::fclose(csv);
  std::printf("peak RSS %.0f MB\n", max_rss_mb());
  return 0;
}

// Compact training run: same schedule flags as bp train. Snapshots are
// GPOCKPT2 checkpoints in OUT/snapshots; bp scale export averages the current
// strategy of every snapshot at or after --snap-from-iter on the streets
// without a running average.
int scale_train(const Args& a) {
  std::signal(SIGTERM, on_stop_signal);
  std::signal(SIGINT, on_stop_signal);
  auto h = setup_holdem(a, true);
  h->tree.print_stats(stdout);
  int avg_streets = int(a.geti("avg-streets", 1));
  print_layout(h->tree, avg_streets, stdout);
  McfrConfig m = holdem_mcfr(a);
  std::string out = a.get("out", "runs/compact-" + h->tcfg.name + "-" + h->acfg.id());
  if (std::system(("mkdir -p '" + out + "/snapshots'").c_str()) != 0) die("cannot create " + out);
  CompactHoldem tr(h->tree, HoldemSampler{&h->abs}, m, avg_streets, true);
  std::string ckpt = out + "/ckpt.cbin";
  if (a.has("resume") && file_exists(ckpt)) {
    if (!tr.load(ckpt, h->hash)) die("--resume: cannot load " + ckpt + ": " + tr.last_error);
    std::printf("resumed from %s at iteration %lld\n", ckpt.c_str(), (long long)tr.iter);
  }
  double minutes = a.getf("minutes", 10);
  int64_t max_iters = a.geti("iters", INT64_MAX);
  double log_every = a.getf("log-every-sec", 30), ckpt_every = a.getf("ckpt-every-min", 5) * 60;
  double snap_every = a.getf("snapshot-every-min", 5) * 60;
  // Streaming snapshot average (OUT/snapavg.f32): every --accum-every-sec once
  // the iteration count reaches --accum-from-iter. Hundreds of these are cheap;
  // the checkpoint-style snapshots above are for resume and archive.
  double accum_every = a.getf("accum-every-sec", 60);
  int64_t accum_from = a.geti("accum-from-iter", 0);
  std::string accum_path = out + "/snapavg.f32", err;
  FILE* log = std::fopen((out + "/log.csv").c_str(), tr.iter > 0 ? "a" : "w");
  if (!log) die("cannot open log");
  double last_accum = now_sec();
  if (tr.iter == 0)
    std::fprintf(log, "iteration,seconds,iters_per_sec,visits_per_sec,avg_pos_regret_mbb,allocated_nodes,table_mb,"
                      "rss_mb,pruned_frac\n");
  double t0 = now_sec(), t_end = t0 + minutes * 60, last_log = t0, last_ckpt = t0, last_snap = t0;
  int64_t last_iter = tr.iter, chunk = 200 * m.threads;
  uint64_t last_vis = 0, last_ex = 0, last_pr = 0;
  while (now_sec() < t_end && tr.iter < max_iters && !g_stop_signal) {
    double c0 = now_sec();
    tr.run(std::min(max_iters, tr.iter + chunk), t_end - c0, chunk, nullptr);
    double cdt = now_sec() - c0;
    if (cdt > 0) chunk = std::max<int64_t>(m.threads, int64_t(double(chunk) / cdt));
    double t = now_sec();
    bool final_round = t >= t_end || tr.iter >= max_iters || g_stop_signal;
    if (t - last_log >= log_every || final_round) {
      double dt = t - last_log;
      uint64_t ex = tr.explored.load(), pr = tr.pruned.load();
      double pfrac = (ex + pr - last_ex - last_pr) ? double(pr - last_pr) / double(ex + pr - last_ex - last_pr) : 0;
      last_ex = ex, last_pr = pr;
      double ips = double(tr.iter - last_iter) / dt, vps = double(tr.visits.load() - last_vis) / dt;
      double reg = tr.avg_positive_regret() * 10.0;
      std::fprintf(log, "%lld,%.1f,%.1f,%.0f,%.4f,%llu,%.2f,%.0f,%.4f\n", (long long)tr.iter, t - t0, ips, vps, reg,
                   (unsigned long long)tr.allocated_nodes(), tr.table_bytes() / 1e6, max_rss_mb(), pfrac);
      std::fflush(log);
      std::printf("[%6.0fs] it=%lld %.0f it/s regret=%.1f mbb nodes=%llu tables=%.1f MB pruned=%.3f\n", t - t0,
                  (long long)tr.iter, ips, reg, (unsigned long long)tr.allocated_nodes(), tr.table_bytes() / 1e6, pfrac);
      std::fflush(stdout);
      last_log = t, last_iter = tr.iter, last_vis = tr.visits.load();
    }
    if (t - last_ckpt >= ckpt_every || final_round) {
      if (!tr.save(ckpt, h->hash)) die("checkpoint failed");
      last_ckpt = t;
    }
    if (tr.iter >= accum_from && (t - last_accum >= accum_every || final_round)) {
      if (!snapshot_accumulate(tr, avg_streets, accum_path, h->hash, &err)) die("snapshot accumulate: " + err);
      last_accum = t;
    }
    if (t - last_snap >= snap_every || final_round) {
      char p[512];
      std::snprintf(p, sizeof p, "%s/snapshots/it%012lld.cbin", out.c_str(), (long long)tr.iter);
      if (!tr.save(p, h->hash)) die("snapshot failed");
      last_snap = t;
    }
  }
  std::fclose(log);
  std::printf("done: %lld iterations; peak RSS %.0f MB; tables %.1f MB; checkpoint %s\n", (long long)tr.iter,
              max_rss_mb(), tr.table_bytes() / 1e6, ckpt.c_str());
  return g_stop_signal ? 75 : 0;
}

int scale_export(const Args& a) {
  auto h = setup_holdem(a, true);
  int avg_streets = int(a.geti("avg-streets", 1));
  McfrConfig m;
  CompactHoldem tr(h->tree, HoldemSampler{&h->abs}, m, avg_streets, true);
  std::string ck = a.get("ckpt");
  if (!tr.load(ck, h->hash)) die("cannot load " + ck + ": " + tr.last_error);
  SnapshotAverage snap(h->tree, avg_streets);
  if (a.has("snap-accum")) {
    std::string err;
    if (!snap.load_file(a.get("snap-accum"), h->hash, &err)) die("cannot load " + a.get("snap-accum") + ": " + err);
    std::printf("snapshot accumulator %s: %lld snapshots\n", a.get("snap-accum").c_str(), (long long)snap.count);
  } else if (a.has("snapshots")) {
    std::string dir = a.get("snapshots");
    std::vector<std::string> files = list_dir(dir, ".cbin");
    std::sort(files.begin(), files.end());
    int64_t from = a.geti("snap-from-iter", 0);
    for (auto& fn : files) {
      CompactHoldem s(h->tree, HoldemSampler{&h->abs}, m, avg_streets, true);
      if (!s.load(dir + "/" + fn, h->hash)) die("cannot load snapshot " + fn + ": " + s.last_error);
      if (s.iter < from) continue;
      snap.add(s);
    }
    std::printf("averaged %lld snapshots from %s\n", (long long)snap.count, dir.c_str());
  }
  StrategyFn pol = compact_policy(tr, &snap);
  auto visited = [&](uint64_t b, int) {
    uint32_t ni = tr.node_of_slot(b);
    const Node& n = h->tree.nodes[ni];
    return tr.visited(ni, int((b - n.slot) / uint64_t(n.nact)));
  };
  std::string extra = "\"iterations\":" + std::to_string(tr.iter) + ",\"trainer\":\"compact\",\"snapshots\":" +
                      std::to_string(snap.count) + ",\"abstraction\":{\"id\":\"" + h->acfg.id() + "\"}";
  std::string out = a.get("out", "blueprint.gpobp");
  if (!export_policy(h->tree, pol, visited, extra, out)) die("export failed");
  std::printf("exported %s\n", out.c_str());
  return 0;
}

// Exact reference on hold'em itself: the dense trainer and the compact trainer,
// single-threaded with the same seed and chunking, must end with identical
// regrets everywhere and identical preflop sums.
int scale_verify(const Args& a) {
  auto h = setup_holdem(a, true);
  McfrConfig m = holdem_mcfr(a);
  m.threads = 1;
  int64_t iters = a.geti("iters", 20000), chunk = a.geti("chunk", 1000);
  HoldemSampler smp{&h->abs};
  Trainer<HoldemSampler> d(h->tree, smp, m);
  CompactHoldem c(h->tree, smp, m, 1, true);
  double t0 = now_sec();
  d.run(iters, 1e9, chunk, nullptr);
  double t1 = now_sec();
  c.run(iters, 1e9, chunk, nullptr);
  double t2 = now_sec();
  std::vector<int32_t> cr = c.dense_regrets();
  std::vector<double> cs = c.dense_sums();
  uint64_t rdiff = 0, sdiff = 0, pre_slots = 0, nonzero = 0;
  for (uint64_t k = 0; k < cr.size(); k++) rdiff += cr[k] != d.R[k], nonzero += d.R[k] != 0;
  for (const Node& n : h->tree.nodes)
    if (n.type == DECISION && n.street == 0)
      for (uint64_t k = n.slot; k < n.slot + uint64_t(h->tree.buckets[0]) * n.nact; k++)
        sdiff += cs[k] != d.S[k], pre_slots++;
  std::printf("verify: %lld iterations, dense %.1fs, compact %.1fs; %llu of %llu regret slots nonzero; "
              "regret mismatches %llu, preflop sum mismatches %llu of %llu; visits %llu vs %llu, pruned %llu vs %llu\n",
              (long long)iters, t1 - t0, t2 - t1, (unsigned long long)nonzero, (unsigned long long)cr.size(),
              (unsigned long long)rdiff, (unsigned long long)sdiff, (unsigned long long)pre_slots,
              (unsigned long long)d.visits.load(), (unsigned long long)c.visits.load(),
              (unsigned long long)d.pruned.load(), (unsigned long long)c.pruned.load());
  std::printf("compact allocated %llu of %zu decision nodes, tables %.2f MB vs dense %.2f MB\n",
              (unsigned long long)c.allocated_nodes(), c.decision_nodes().size(), c.table_bytes() / 1e6,
              h->tree.num_slots * 12.0 / 1e6);
  bool ok = rdiff == 0 && sdiff == 0 && d.visits.load() == c.visits.load();
  std::printf("%s\n", ok ? "PASS: identical" : "FAIL");
  return ok ? 0 : 2;
}

int cmd_scale(int argc, char** argv) {
  if (argc < 3) die("usage: bp scale <gate|verify|tree|bench|train|export> [--options]");
  std::string sub = argv[2];
  Args a = parse(argc, argv, 3);
  if (sub == "gate") return scale_gate(a);
  if (sub == "tree") return scale_tree(a);
  if (sub == "bench") return scale_bench(a);
  if (sub == "train") return scale_train(a);
  if (sub == "export") return scale_export(a);
  if (sub == "verify") return scale_verify(a);
  die("unknown bp scale command " + sub);
}
// ---- end PLAN.md M3 block ----------------------------------------------------------

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: bp <gate|abs|tree|bench|train|h2h|br|export|show|scale> [--options]\n"
                         "see blueprint/README.md\n");
    return 2;
  }
  std::string cmd = argv[1];
  if (cmd == "scale") return cmd_scale(argc, argv);  // PLAN.md M3
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
