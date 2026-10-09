// ============================================================
// search.cpp: see search.h.
// ============================================================
#include "search.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <thread>

#include <atomic>

#include "abstraction.h"
#include "eval.h"
#include "games.h"

namespace bp {
namespace rt {

// ---- blueprint subtree copy ---------------------------------------------------------

namespace {

struct BpBuilder {
  Game& g;
  const BpView& bv;
  bool dl;
  int32_t base[2];
  std::vector<uint32_t> leaves;

  SNode make(uint32_t bpn, int parent, const std::vector<int>& board) {
    const Node& c = bv.tree->nodes[bpn];
    SNode k;
    k.parent = parent;
    k.bp = int(bpn);
    k.c[0] = c.contrib[0] - base[0];
    k.c[1] = c.contrib[1] - base[1];
    k.pot = g.pot0 + k.c[0] + k.c[1];
    k.board = g.add_board(board);
    return k;
  }

  void expand(int idx, uint32_t bpn, const std::vector<int>& board) {
    const BettingTree& t = *bv.tree;
    const Node n = t.nodes[bpn];
    int first = int(g.nodes.size());
    for (int a = 0; a < n.nact; a++) {
      uint32_t ci = n.child + a;
      const Node& c = t.nodes[ci];
      SNode k = make(ci, idx, board);
      k.label = t.token(ci);
      if (c.type == FOLD) k.type = S_FOLD, k.player = c.player;
      else if (c.type == SHOWDOWN) k.type = S_SHOW;
      else if (c.street == n.street) k.type = S_DEC, k.player = c.player;
      else if (dl) {
        k.type = S_LEAF;
        k.leaf = int(leaves.size());
        leaves.push_back(ci);
      } else {
        k.type = S_CHANCE;
      }
      add_node(g, k);
    }
    g.nodes[idx].type = S_DEC;
    g.nodes[idx].player = n.player;
    g.nodes[idx].first = first;
    g.nodes[idx].nact = n.nact;
    for (int a = 0; a < n.nact; a++) {
      int ch = first + a;
      uint8_t ty = g.nodes[ch].type;
      if (ty == S_DEC) expand(ch, n.child + a, board);
      else if (ty == S_CHANCE) expand_chance(ch, n.child + a, board);
    }
  }

  void expand_chance(int idx, uint32_t bpn, const std::vector<int>& board) {
    const Node& n = bv.tree->nodes[bpn];
    int need = bv.board_len[n.street] - int(board.size());
    if (need != 1) die("search: chance nodes deal exactly one card (start the subgame on the flop or later)");
    uint64_t bm = 0;
    for (int c : board) bm |= 1ull << c;
    int first = int(g.nodes.size());
    std::vector<int> cards;
    for (int x = 0; x < bv.deck; x++)
      if (!(bm >> x & 1)) cards.push_back(x);
    for (int x : cards) {
      std::vector<int> b2 = board;
      b2.push_back(x);
      SNode k = make(bpn, idx, b2);
      k.type = S_DEC;
      k.player = n.player;
      k.deal = x;
      k.label = bv.deck == 52 ? card_str(x) : "d" + std::to_string(x);
      add_node(g, k);
    }
    g.nodes[idx].first = first;
    g.nodes[idx].nact = int(cards.size());
    for (size_t k = 0; k < cards.size(); k++) {
      std::vector<int> b2 = board;
      b2.push_back(cards[k]);
      expand(first + int(k), bpn, b2);
    }
  }
};

}  // namespace

std::vector<uint32_t> build_from_blueprint(Game& g, const BpView& bv, uint32_t root, const std::vector<int>& board,
                                           bool depth_limited) {
  const Node& r = bv.tree->nodes[root];
  if (r.type != DECISION) die("search: subgame root must be a decision node");
  g.nodes.clear();
  g.boards.clear();
  g.leaves.clear();
  g.deck = bv.deck;
  g.cards_per_hand = bv.cards_per_hand;
  g.full_board = bv.board_len.back();
  g.strength = bv.strength;
  g.pot0 = double(r.contrib[0] + r.contrib[1]);
  BpBuilder b{g, bv, depth_limited, {r.contrib[0], r.contrib[1]}, {}};
  SNode s = b.make(root, -1, board);
  add_node(g, s);
  b.expand(0, root, board);
  g.leaves.assign(b.leaves.size(), LeafValues{});
  return b.leaves;
}

void continuation(const BettingTree& t, const Node& n, const double* sigma, int choice, double bias, double* out) {
  double s = 0;
  for (int a = 0; a < n.nact; a++) {
    int k = t.nodes[n.child + a].act_kind;
    bool hit = (choice == 1 && k == ACT_FOLD) || (choice == 2 && (k == ACT_CHECK || k == ACT_CALL)) ||
               (choice == 3 && (k == ACT_BET || k == ACT_RAISE || k == ACT_ALLIN));
    out[a] = sigma[a] * (hit ? bias : 1.0);
    s += out[a];
  }
  for (int a = 0; a < n.nact; a++) out[a] = s > 0 ? out[a] / s : 1.0 / n.nact;
}

// ---- leaf values ------------------------------------------------------------------

namespace {

struct LeafWork {
  const Game& g;
  const BpView& bv;
  int k;
  double bias;
  int H0, H1;
  // per runout
  std::vector<int> full;
  std::vector<char> valid[2];
  std::vector<std::vector<int>> bucket[2];  // [street][hand]
  std::vector<double> P, Q;                  // [(a*k+b)*H0*H1 + i*H1 + j]

  LeafWork(const Game& g_, const BpView& bv_, int k_, double b_) : g(g_), bv(bv_), k(k_), bias(b_) {
    H0 = g.n(0);
    H1 = g.n(1);
    P.assign(size_t(k) * k * H0 * H1, 0.0);
    Q.assign(P.size(), 0.0);
  }

  void outer(double* M, const double* x, const double* y, double s) {
    for (int i = 0; i < H0; i++) {
      double xi = x[i] * s;
      if (xi == 0) continue;
      double* row = M + size_t(i) * H1;
      for (int j = 0; j < H1; j++) row[j] += xi * y[j];
    }
  }

  void walk(uint32_t ni, const std::vector<double>& pi0, const std::vector<double>& pi1, const int32_t base[2]) {
    const BettingTree& t = *bv.tree;
    const Node& n = t.nodes[ni];
    const size_t HH = size_t(H0) * H1;
    if (n.type != DECISION) {
      double c0 = n.contrib[0] - base[0], c1 = n.contrib[1] - base[1];
      double pot = g.pot0 + c0 + c1;
      for (int a = 0; a < k; a++)
        for (int b = 0; b < k; b++) {
          const double* x = &pi0[size_t(a) * H0];
          const double* y = &pi1[size_t(b) * H1];
          size_t o = (size_t(a) * k + b) * HH;
          if (n.type == FOLD) {
            double u0 = n.player == 0 ? -c0 : pot - c0;
            outer(&Q[o], x, y, u0);
          } else {
            outer(&P[o], x, y, pot);
            outer(&Q[o], x, y, -c0);
          }
        }
      return;
    }
    const int pl = n.player, na = n.nact, H = pl == 0 ? H0 : H1;
    const std::vector<double>& pi = pl == 0 ? pi0 : pi1;
    std::vector<std::vector<double>> kid(na, std::vector<double>(size_t(k) * H, 0.0));
    double sig[MAX_ACTIONS], cont[MAX_ACTIONS];
    const auto& bk = bucket[pl][n.street];
    for (int h = 0; h < H; h++) {
      if (!valid[pl][h]) continue;
      bv.policy(n.slot + uint64_t(bk[h]) * na, na, sig);
      for (int c = 0; c < k; c++) {
        double r = pi[size_t(c) * H + h];
        if (r == 0) continue;
        continuation(t, n, sig, c, bias, cont);
        for (int a = 0; a < na; a++) kid[a][size_t(c) * H + h] = r * cont[a];
      }
    }
    for (int a = 0; a < na; a++) {
      if (pl == 0) walk(n.child + a, kid[a], pi1, base);
      else walk(n.child + a, pi0, kid[a], base);
    }
  }
};

}  // namespace

void build_leaf_values(Game& g, const BpView& bv, const std::vector<uint32_t>& leaf_bp, const std::vector<int>& board,
                       int k, double bias, int rollouts, uint64_t seed, int threads) {
  const int H0 = g.n(0), H1 = g.n(1);
  const size_t HH = size_t(H0) * H1;
  const int need = bv.board_len.back() - int(board.size());
  uint64_t bm = 0;
  for (int c : board) bm |= 1ull << c;
  std::vector<int> live;
  for (int x = 0; x < bv.deck; x++)
    if (!(bm >> x & 1)) live.push_back(x);
  // Runouts (ordered: the first card is the next street's card).
  std::vector<std::vector<int>> runs;
  if (rollouts <= 0) {
    std::vector<int> cur;
    std::function<void()> rec = [&]() {
      if (int(cur.size()) == need) {
        runs.push_back(cur);
        return;
      }
      for (int x : live)
        if (std::find(cur.begin(), cur.end(), x) == cur.end()) {
          cur.push_back(x);
          rec();
          cur.pop_back();
        }
    };
    rec();
  } else {
    Rng rng(seed);
    for (int r = 0; r < rollouts; r++) {
      std::vector<int> cur;
      while (int(cur.size()) < need) {
        int x = live[rng.below(uint32_t(live.size()))];
        if (std::find(cur.begin(), cur.end(), x) == cur.end()) cur.push_back(x);
      }
      runs.push_back(cur);
    }
  }
  auto do_leaf = [&](size_t l) {
    LeafValues& L = g.leaves[l];
    L.k[0] = L.k[1] = k;
    L.V.assign(size_t(k) * k * HH, 0.0);
    std::vector<double> cnt(HH, 0.0);
    LeafWork W(g, bv, k, bias);
    // contributions at the subgame root: recover from the leaf's own node
    // (contrib at the leaf minus the subgame's c at that leaf).
    int32_t b0[2];
    {
      // find the S_LEAF node holding this leaf to read its c[]
      for (const SNode& s : g.nodes)
        if (s.type == S_LEAF && s.leaf == int(l)) {
          const Node& bn = bv.tree->nodes[leaf_bp[l]];
          b0[0] = bn.contrib[0] - int32_t(std::lround(s.c[0]));
          b0[1] = bn.contrib[1] - int32_t(std::lround(s.c[1]));
          break;
        }
    }
    const uint32_t L0 = leaf_bp[l];
    const int st0 = bv.tree->nodes[L0].street;
    const int nst = int(bv.board_len.size());
    for (auto& ro : runs) {
      W.full = board;
      uint64_t rm = 0;
      for (int x : ro) W.full.push_back(x), rm |= 1ull << x;
      std::vector<int32_t> str[2];
      for (int p = 0; p < 2; p++) {
        const int H = g.n(p);
        W.valid[p].assign(H, 0);
        W.bucket[p].assign(nst, std::vector<int>(H, 0));
        str[p].assign(H, -1);
        for (int h = 0; h < H; h++) {
          const Hand& hd = g.hands[p][h];
          if (hd.mask & (rm | bm)) continue;
          W.valid[p][h] = 1;
          for (int s = st0; s < nst; s++) {
            std::vector<int> pre(W.full.begin(), W.full.begin() + bv.board_len[s]);
            W.bucket[p][s][h] = bv.bucket(hd, pre, s);
          }
          str[p][h] = bv.strength(hd, W.full);
        }
      }
      std::fill(W.P.begin(), W.P.end(), 0.0);
      std::fill(W.Q.begin(), W.Q.end(), 0.0);
      std::vector<double> pi0(size_t(k) * H0, 0.0), pi1(size_t(k) * H1, 0.0);
      for (int c = 0; c < k; c++) {
        for (int i = 0; i < H0; i++) pi0[size_t(c) * H0 + i] = W.valid[0][i] ? 1.0 : 0.0;
        for (int j = 0; j < H1; j++) pi1[size_t(c) * H1 + j] = W.valid[1][j] ? 1.0 : 0.0;
      }
      W.walk(L0, pi0, pi1, b0);
      for (int i = 0; i < H0; i++) {
        if (!W.valid[0][i]) continue;
        for (int j = 0; j < H1; j++) {
          size_t ij = size_t(i) * H1 + j;
          if (!W.valid[1][j] || g.compat[ij] == 0.f) continue;
          double sh = str[0][i] > str[1][j] ? 1.0 : str[0][i] < str[1][j] ? 0.0 : 0.5;
          cnt[ij] += 1;
          for (int ab = 0; ab < k * k; ab++) {
            size_t o = size_t(ab) * HH + ij;
            L.V[o] += sh * W.P[o] + W.Q[o];
          }
        }
      }
    }
    for (int ab = 0; ab < k * k; ab++)
      for (size_t ij = 0; ij < HH; ij++) {
        size_t o = size_t(ab) * HH + ij;
        L.V[o] = cnt[ij] > 0 ? L.V[o] / cnt[ij] : 0.0;
      }
    // A compatible pair that no sampled runout covered keeps value 0 (only
    // possible with very few rollouts); the exact mode covers every pair.
  };
  const size_t NL = leaf_bp.size();
  int T = std::max(1, std::min<int>(threads, int(NL)));
  std::vector<std::thread> pool;
  std::atomic<size_t> next{0};
  for (int t = 0; t < T; t++)
    pool.emplace_back([&] {
      for (size_t l; (l = next.fetch_add(1)) < NL;) do_leaf(l);
    });
  for (auto& th : pool) th.join();
}

// ---- beliefs ----------------------------------------------------------------------

std::vector<double> blueprint_reach(const BpView& bv, const std::vector<Hand>& hands, int p, uint32_t node,
                                    const std::vector<int>& board) {
  const BettingTree& t = *bv.tree;
  std::vector<double> r(hands.size(), 1.0);
  uint64_t bm = 0;
  for (int c : board) bm |= 1ull << c;
  for (size_t h = 0; h < hands.size(); h++)
    if (hands[h].mask & bm) r[h] = 0;
  uint32_t cur = node;
  double sig[MAX_ACTIONS];
  while (cur != 0) {
    uint32_t par = t.nodes[cur].parent;
    const Node& pn = t.nodes[par];
    int a = int(cur - pn.child);
    if (pn.player == p) {
      std::vector<int> pre(board.begin(), board.begin() + bv.board_len[pn.street]);
      for (size_t h = 0; h < hands.size(); h++) {
        if (r[h] == 0) continue;
        int b = bv.bucket(hands[h], pre, pn.street);
        bv.policy(pn.slot + uint64_t(b) * pn.nact, pn.nact, sig);
        r[h] *= sig[a];
      }
    }
    cur = par;
  }
  return r;
}

uint32_t round_start(const BettingTree& t, uint32_t node) {
  while (node != 0 && t.nodes[t.nodes[node].parent].street == t.nodes[node].street) node = t.nodes[node].parent;
  return node;
}

BpView holdem_view(const BettingTree& t, const Abstraction& abs, const std::vector<float>& pol) {
  BpView v;
  v.tree = &t;
  const std::vector<float>* P = &pol;
  v.policy = [P](uint64_t base, int na, double* out) {
    double s = 0;
    for (int a = 0; a < na; a++) s += out[a] = (*P)[base + a];
    for (int a = 0; a < na; a++) out[a] = s > 0 ? out[a] / s : 1.0 / na;
  };
  const Abstraction* A = &abs;
  v.bucket = [A](const Hand& h, const std::vector<int>& b, int street) -> int {
    switch (street) {
      case 0: return preflop_class(h.c[0], h.c[1]);
      case 1: return A->flop(h.c, b.data());
      case 2: return A->turn(h.c, b.data());
      default: return A->river(h.c, b.data());
    }
  };
  v.strength = holdem_strength;
  v.deck = 52;
  v.cards_per_hand = 2;
  v.board_len = {0, 3, 4, 5};
  return v;
}

// ---- CLI ---------------------------------------------------------------------------

namespace {

struct KV {
  const std::map<std::string, std::string>& m;
  std::string get(const std::string& k, const std::string& d = "") const {
    auto it = m.find(k);
    return it == m.end() ? d : it->second;
  }
  double f(const std::string& k, double d) const {
    auto it = m.find(k);
    return it == m.end() ? d : std::stod(it->second);
  }
  long long i(const std::string& k, long long d) const {
    auto it = m.find(k);
    return it == m.end() ? d : std::stoll(it->second);
  }
  bool has(const std::string& k) const { return m.count(k) > 0; }
};

std::vector<int> parse_cards(const std::string& s) {
  std::vector<int> out;
  std::string t;
  for (size_t i = 0; i + 1 < s.size();) {
    if (s[i] == ' ' || s[i] == ',') {
      i++;
      continue;
    }
    int c = parse_card(&s[i]);
    if (c < 0) die("bad card in '" + s + "'");
    out.push_back(c);
    i += 2;
  }
  return out;
}

std::vector<std::string> split_ws(const std::string& s) {
  std::vector<std::string> out;
  std::stringstream ss(s);
  std::string t;
  while (ss >> t) out.push_back(t);
  return out;
}

std::vector<Hand> all_combos(uint64_t dead) {
  std::vector<Hand> out;
  for (int a = 1; a < 52; a++)
    for (int b = 0; b < a; b++) {
      if ((dead >> a & 1) || (dead >> b & 1)) continue;
      Hand h;
      h.c[0] = a;
      h.c[1] = b;
      h.nc = 2;
      h.mask = (1ull << a) | (1ull << b);
      out.push_back(h);
    }
  return out;
}

// Keep the `cap` highest-weight hands with positive weight (and `keep`).
void cap_range(std::vector<Hand>& hs, std::vector<double>& w, size_t cap, int keep_mask_idx, uint64_t keep_mask) {
  std::vector<size_t> idx;
  double mx = 0;
  for (size_t i = 0; i < hs.size(); i++) mx = std::max(mx, w[i]);
  for (size_t i = 0; i < hs.size(); i++)
    if (w[i] > 0 || (keep_mask_idx >= 0 && hs[i].mask == keep_mask)) idx.push_back(i);
  std::stable_sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return w[a] > w[b]; });
  std::vector<Hand> h2;
  std::vector<double> w2;
  bool have_keep = false;
  for (size_t x = 0; x < idx.size() && h2.size() < cap; x++) {
    h2.push_back(hs[idx[x]]);
    w2.push_back(w[idx[x]]);
    if (hs[idx[x]].mask == keep_mask) have_keep = true;
  }
  if (keep_mask_idx >= 0 && !have_keep) {
    for (size_t i = 0; i < hs.size(); i++)
      if (hs[i].mask == keep_mask) {
        h2.push_back(hs[i]);
        w2.push_back(std::max(w[i], mx * 1e-9));
      }
  }
  for (auto& x : w2)
    if (x <= 0) x = mx * 1e-9;
  hs.swap(h2);
  w.swap(w2);
}

struct SearchSpot {
  uint32_t node = 0, rs = 0;
  std::vector<int> board;
  int hero = 0;
  Hand hero_hand;
};

struct SearchOut {
  std::vector<std::string> labels;
  std::vector<double> strat, bp_strat;
  double expl = 0, pot0 = 0, setup_s = 0, solve_s = 0;
  int iters = 0, H[2] = {0, 0}, leaves = 0, nodes = 0;
};

// One search: ranges from the blueprint, subgame from the round start,
// solve under the budget, return the hero hand's strategy at `node`.
SearchOut run_search(const BpView& bv, const SearchSpot& sp, int k, double bias, size_t max_hands, int rollouts,
                     double budget_s, int max_iters, int threads, uint64_t seed, bool want_expl) {
  SearchOut o;
  const BettingTree& t = *bv.tree;
  double t0 = now_sec();
  uint64_t bm = 0;
  for (int c : sp.board) bm |= 1ull << c;
  Game g;
  for (int p = 0; p < 2; p++) {
    g.hands[p] = all_combos(bm);
    g.w[p] = blueprint_reach(bv, g.hands[p], p, sp.rs, sp.board);
    cap_range(g.hands[p], g.w[p], max_hands, p == sp.hero ? 0 : -1, sp.hero_hand.mask);
  }
  const int street = t.nodes[sp.rs].street;
  std::vector<uint32_t> leaf_bp = build_from_blueprint(g, bv, sp.rs, sp.board, street == 1);
  g.finalize();
  if (!leaf_bp.empty()) build_leaf_values(g, bv, leaf_bp, sp.board, k, bias, rollouts, seed, threads);
  // Locate the decision node and the hero's own in-round actions.
  std::vector<uint32_t> path;
  for (uint32_t c = sp.node; c != sp.rs; c = t.nodes[c].parent) path.push_back(c);
  std::reverse(path.begin(), path.end());
  int cur = 0;
  int hero_idx = -1;
  for (int i = 0; i < g.n(sp.hero); i++)
    if (g.hands[sp.hero][i].mask == sp.hero_hand.mask) hero_idx = i;
  SolverConfig sc;
  sc.threads = threads;
  Solver S(g, sc);
  for (uint32_t c : path) {
    const SNode& nd = g.nodes[cur];
    int a = int(c - t.nodes[t.nodes[c].parent].child);
    if (nd.player == sp.hero && hero_idx >= 0) S.freeze(cur, hero_idx, a);
    cur = nd.first + a;
  }
  if (g.nodes[cur].bp != int(sp.node)) die("search: subgame node does not match the blueprint node");
  o.setup_s = now_sec() - t0;
  double t1 = now_sec();
  while (S.iterations() < max_iters && (S.iterations() < 1 || now_sec() - t0 < budget_s)) S.iterate();
  o.solve_s = now_sec() - t1;
  o.iters = S.iterations();
  const SNode& nd = g.nodes[cur];
  o.strat.resize(nd.nact);
  S.average(cur, hero_idx, o.strat.data());
  for (int a = 0; a < nd.nact; a++) o.labels.push_back(g.nodes[nd.first + a].label);
  const Node& bn = t.nodes[sp.node];
  std::vector<int> pre(sp.board.begin(), sp.board.begin() + bv.board_len[bn.street]);
  o.bp_strat.resize(bn.nact);
  bv.policy(bn.slot + uint64_t(bv.bucket(sp.hero_hand, pre, bn.street)) * bn.nact, bn.nact, o.bp_strat.data());
  if (want_expl) o.expl = S.exploitability();
  o.pot0 = g.pot0;
  o.H[0] = g.n(0);
  o.H[1] = g.n(1);
  o.leaves = int(leaf_bp.size());
  o.nodes = int(g.nodes.size());
  return o;
}

int cmd_search(const KV& a, const BettingTree& tree, const Abstraction& abs, const std::vector<float>& pol) {
  BpView bv = holdem_view(tree, abs, pol);
  SearchSpot sp;
  sp.board = parse_cards(a.get("board"));
  std::vector<int> hh = parse_cards(a.get("hand"));
  if (hh.size() != 2) die("search: --hand needs two cards, e.g. 'Qs Qh'");
  sp.hero_hand.c[0] = hh[0];
  sp.hero_hand.c[1] = hh[1];
  sp.hero_hand.nc = 2;
  sp.hero_hand.mask = (1ull << hh[0]) | (1ull << hh[1]);
  int64_t ni = tree.find(split_ws(a.get("history")));
  if (ni < 0 || tree.nodes[ni].type != DECISION) die("search: history not found in the blueprint tree or terminal");
  sp.node = uint32_t(ni);
  const Node& n = tree.nodes[sp.node];
  if (n.street == 0) die("search: preflop search is not implemented (play the blueprint preflop)");
  if (int(sp.board.size()) != bv.board_len[n.street]) die("search: board size does not match the street of the history");
  sp.hero = n.player;
  sp.rs = round_start(tree, sp.node);
  int k = int(a.i("k", 4));
  size_t cap = size_t(a.i("max-hands", n.street == 1 ? 120 : n.street == 2 ? 300 : 1326));
  SearchOut o = run_search(bv, sp, k, a.f("bias", 5), cap, int(a.i("rollouts", 24)), a.f("budget-ms", 2000) / 1000.0,
                           int(a.i("max-iters", 1000000)), int(a.i("threads", 4)), uint64_t(a.i("seed", 1)), true);
  std::printf("search: street %d, player %d to act, history '%s', round start '%s'\n", n.street, sp.hero,
              tree.history(sp.node).c_str(), tree.history(sp.rs).c_str());
  std::printf("subgame: %d nodes, %d depth-limit leaves (k=%d), hands %d vs %d, pot0 %.0f\n", o.nodes, o.leaves,
              o.leaves ? k : 0, o.H[0], o.H[1], o.pot0);
  std::printf("setup %.3fs, solve %.3fs, %d iterations, exploitability %.2f chips (%.3f%% of pot0, within the "
              "subgame model)\n",
              o.setup_s, o.solve_s, o.iters, o.expl, 100 * o.expl / o.pot0);
  std::printf("%-8s %8s %8s\n", "action", "search", "blueprint");
  for (size_t x = 0; x < o.labels.size(); x++)
    std::printf("%-8s %8.4f %8.4f\n", o.labels[x].c_str(), o.strat[x], o.bp_strat[x]);
  return 0;
}

// River-only search agent vs pure blueprint.
//
// Estimator. Both agents play the blueprint before the river, so for a
// fixed deal and a fixed stream of pre-river action samples the two agents
// reach the same river spot. At that spot the searcher solves the river from
// its start (unsafe, beliefs from the blueprint reach of both players) and
// the hand's value is computed EXACTLY by walking the river subtree:
//   delta = EV(searcher's river strategy for its hand vs the opponent's
//              blueprint) - EV(blueprint vs blueprint)
// and delta = 0 for hands that end before the river. Since blueprint vs
// blueprint is worth exactly 0 over the two seats of a duplicate deal, the
// mean of delta (averaged over both seats per deal) is an unbiased estimate
// of the searcher's win rate against the blueprint, with the river's
// action-sampling noise removed (a control variate with known mean).
int cmd_search_h2h(const KV& a, const BettingTree& tree, const Abstraction& abs, const std::vector<float>& pol) {
  BpView bv = holdem_view(tree, abs, pol);
  const int64_t deals = a.i("hands", 1000);
  const int threads = int(a.i("threads", 4));
  const int iters = int(a.i("iters", 200));
  const uint64_t seed = uint64_t(a.i("seed", 7));
  HoldemSampler smp{&abs};
  std::vector<double> sum(threads, 0), sq(threads, 0), stime(threads, 0);
  std::vector<int64_t> nsearch(threads, 0);
  std::vector<std::thread> pool;
  double t_start = now_sec();
  for (int th = 0; th < threads; th++)
    pool.emplace_back([&, th] {
      Rng rng(seed * 7919 + uint64_t(th));
      Deal d;
      int64_t n = deals / threads + (th < deals % threads ? 1 : 0);
      for (int64_t i = 0; i < n; i++) {
        smp.sample(rng, d);
        std::vector<int> board(d.board, d.board + 5);
        double r = 0;
        for (int seat = 0; seat < 2; seat++) {  // seat = the searcher's position
          uint32_t ni = 0;
          double sig[MAX_ACTIONS];
          while (tree.nodes[ni].type == DECISION && tree.nodes[ni].street < 3) {
            const Node& nd = tree.nodes[ni];
            bv.policy(nd.slot + uint64_t(d.bucket[nd.player][nd.street]) * nd.nact, nd.nact, sig);
            double u = rng.uniform(), acc = 0;
            int pick = nd.nact - 1;
            for (int x = 0; x < nd.nact; x++) {
              acc += sig[x];
              if (u < acc) {
                pick = x;
                break;
              }
            }
            ni = nd.child + pick;
          }
          if (tree.nodes[ni].type != DECISION) continue;  // ended before the river: delta 0
          const uint32_t rs = ni;
          double ts = now_sec();
          Hand hero;
          hero.c[0] = d.hole[seat][0];
          hero.c[1] = d.hole[seat][1];
          hero.nc = 2;
          hero.mask = (1ull << hero.c[0]) | (1ull << hero.c[1]);
          uint64_t bm = 0;
          for (int c : board) bm |= 1ull << c;
          Game g;
          for (int p = 0; p < 2; p++) {
            g.hands[p] = all_combos(bm);
            g.w[p] = blueprint_reach(bv, g.hands[p], p, rs, board);
            cap_range(g.hands[p], g.w[p], 1326, p == seat ? 0 : -1, hero.mask);
          }
          build_from_blueprint(g, bv, rs, board, false);
          g.finalize();
          int hidx = -1;
          for (int x = 0; x < g.n(seat); x++)
            if (g.hands[seat][x].mask == hero.mask) hidx = x;
          Solver S(g, SolverConfig{});
          for (int it = 0; it < iters; it++) S.iterate();
          std::map<uint32_t, std::vector<double>> plan;
          for (int x = 0; x < int(g.nodes.size()); x++)
            if (g.nodes[x].type == S_DEC && g.nodes[x].player == seat) {
              std::vector<double> st(g.nodes[x].nact);
              S.average(x, hidx, st.data());
              plan[uint32_t(g.nodes[x].bp)] = st;
            }
          stime[th] += now_sec() - ts;
          nsearch[th]++;
          std::function<double(uint32_t, bool)> ev = [&](uint32_t v, bool search) -> double {
            const Node& nd = tree.nodes[v];
            if (nd.type != DECISION) return terminal_utility(nd, seat, d.winner);
            double pr[MAX_ACTIONS];
            if (search && nd.player == seat) {
              const std::vector<double>& st = plan.at(v);
              for (int x = 0; x < nd.nact; x++) pr[x] = st[x];
            } else {
              bv.policy(nd.slot + uint64_t(d.bucket[nd.player][nd.street]) * nd.nact, nd.nact, pr);
            }
            double s = 0;
            for (int x = 0; x < nd.nact; x++)
              if (pr[x] > 0) s += pr[x] * ev(nd.child + x, search);
            return s;
          };
          r += ev(rs, true) - ev(rs, false);
        }
        r *= 0.5;
        sum[th] += r;
        sq[th] += r * r;
      }
    });
  for (auto& p : pool) p.join();
  double S = 0, Q = 0, T = 0;
  int64_t NS = 0;
  for (int t = 0; t < threads; t++) S += sum[t], Q += sq[t], T += stime[t], NS += nsearch[t];
  double mean = S / deals, var = Q / deals - mean * mean, ci = 1.96 * std::sqrt(var / deals);
  std::printf("search-h2h: blueprint + river search (%d DCFR iterations, unsafe, from the river start) vs blueprint: "
              "%+.1f mbb/hand (95%% CI +/- %.1f, %lld duplicate deals = %lld hands, exact river EV)\n",
              iters, mean * 10, ci * 10, (long long)deals, (long long)deals * 2);
  std::printf("river searches %lld, mean %.3fs per search (thread time), wall %.1fs\n", (long long)NS,
              NS ? T / NS : 0.0, now_sec() - t_start);
  return 0;
}

}  // namespace

int search_cli(const std::string& cmd, const std::map<std::string, std::string>& kv, const BettingTree& tree,
               const Abstraction& abs, const std::vector<float>& pol) {
  KV a{kv};
  if (cmd == "search") return cmd_search(a, tree, abs, pol);
  if (cmd == "search-h2h") return cmd_search_h2h(a, tree, abs, pol);
  die("unknown search command " + cmd);
}

// ---- `bp subgame`: TS spot cross-check ------------------------------------------------
//
// Spot file format (written by blueprint/scripts/export-ts-spots.ts):
//   spot NAME
//   board c c c c [c]                  card ids (rank*4 + suit)
//   params POT STACK TOCALL HEROIP PRIOR MAXAGGR ALLINSPR ALLINTHR
//   bet f f ...      / raise f ...
//   hands P N        then N lines "c0 c1 weight" (P = 0 hero, 1 villain)
//   ts ITERS EXPL VALUE0 MS            TS result after ITERS DCFR iterations
//   strat LINE NACT N                  then NACT*N numbers ([action*N + hand]); LINE "-" = root
//   end
int subgame_cli(const std::map<std::string, std::string>& kv) {
  KV a{kv};
  std::ifstream in(a.get("spots"));
  if (!in) die("subgame: cannot open --spots file");
  std::string tok;
  int nspots = 0, fails = 0;
  double worst_expl_diff = 0, worst_iter_diff = 0;
  std::printf("%-10s %5s %4s %4s %6s %12s %12s %12s %12s %10s %9s %9s\n", "spot", "board", "H", "V", "iters",
              "ts_expl", "cpp(ts_strat)", "cpp_expl", "value_diff", "bound", "ts_ms", "cpp_ms");
  while (in >> tok) {
    if (tok != "spot") die("subgame: expected 'spot', got " + tok);
    std::string name;
    in >> name;
    TsTreeParams P;
    std::vector<int> board;
    Game g;
    g.cards_per_hand = 2;
    int ts_iters = 0;
    double ts_expl = 0, ts_v0 = 0, ts_ms = 0;
    std::map<std::string, std::vector<double>> strat;
    std::map<std::string, int> strat_n;
    while (in >> tok && tok != "end") {
      if (tok == "board") {
        std::string line;
        std::getline(in, line);
        std::stringstream ss(line);
        int c;
        while (ss >> c) board.push_back(c);
      } else if (tok == "params") {
        int ip;
        in >> P.starting_pot >> P.effective_stack >> P.to_call >> ip >> P.prior_aggressions >> P.max_aggressions >>
            P.allin_max_spr >> P.allin_threshold;
        P.hero_ip = ip != 0;
      } else if (tok == "bet" || tok == "raise") {
        std::string line;
        std::getline(in, line);
        std::stringstream ss(line);
        double f;
        auto& v = tok == "bet" ? P.bet_fracs : P.raise_fracs;
        while (ss >> f) v.push_back(f);
      } else if (tok == "hands") {
        int p, n;
        in >> p >> n;
        for (int i = 0; i < n; i++) {
          Hand h;
          double w;
          in >> h.c[0] >> h.c[1] >> w;
          h.nc = 2;
          g.hands[p].push_back(h);
          g.w[p].push_back(w);
        }
      } else if (tok == "ts") {
        in >> ts_iters >> ts_expl >> ts_v0 >> ts_ms;
      } else if (tok == "strat") {
        std::string line;
        int na, n;
        in >> line >> na >> n;
        if (line == "-") line = "";
        std::vector<double> v(size_t(na) * n);
        for (auto& x : v) in >> x;
        strat[line] = v;
        strat_n[line] = n;
      } else {
        die("subgame: unknown token " + tok);
      }
    }
    build_ts_tree(g, P, board);
    g.strength = holdem_strength;
    g.finalize();
    // 1) score the TS strategy with the C++ evaluator
    Solver ev(g, SolverConfig{});
    bool missing = false;
    std::vector<std::string> lines(g.nodes.size());
    for (size_t x = 0; x < g.nodes.size(); x++) lines[x] = g.line(int(x));
    ev.external = [&](int node, int h, double* out) {
      auto it = strat.find(lines[node]);
      int na = g.nodes[node].nact;
      if (it == strat.end()) {
        missing = true;
        for (int q = 0; q < na; q++) out[q] = 1.0 / na;
        return;
      }
      int n = strat_n[lines[node]];
      for (int q = 0; q < na; q++) out[q] = it->second[size_t(q) * n + h];
    };
    double cpp_of_ts = ev.exploitability();
    double v_ts = ev.value(0, false);
    // 2) solve with the same algorithm and iteration count
    double t0 = now_sec();
    Solver S(g, SolverConfig{});
    for (int i = 0; i < ts_iters; i++) S.iterate();
    double cpp_ms = (now_sec() - t0) * 1000;
    double e = S.exploitability();
    double v = S.value(0, false);
    double bound = 2 * (e + cpp_of_ts);
    bool ok = !missing && std::fabs(cpp_of_ts - ts_expl) <= 1e-6 * std::max(1.0, P.starting_pot) &&
              std::fabs(v - v_ts) <= bound + 1e-9 && std::fabs(v_ts - ts_v0) <= 1e-6 * std::max(1.0, P.starting_pot);
    worst_expl_diff = std::max(worst_expl_diff, std::fabs(cpp_of_ts - ts_expl));
    worst_iter_diff = std::max(worst_iter_diff, std::fabs(e - ts_expl));
    if (!ok) {
      fails++;
      std::printf("  detail: missing=%d |eval-ts|=%.3g |v-v_ts|=%.3g bound=%.3g |v_ts-ts_v0|=%.3g (v_ts %.9f ts_v0 %.9f)\n",
                  int(missing), std::fabs(cpp_of_ts - ts_expl), std::fabs(v - v_ts), bound, std::fabs(v_ts - ts_v0),
                  v_ts, ts_v0);
    }
    nspots++;
    std::printf("%-10s %5zu %4d %4d %6d %12.6f %12.6f %12.6f %12.6f %10.6f %9.1f %9.1f %s\n", name.c_str(),
                board.size(), g.n(0), g.n(1), ts_iters, ts_expl, cpp_of_ts, e, v - v_ts, bound, ts_ms, cpp_ms,
                ok ? "ok" : "MISMATCH");
  }
  std::printf("%d spots, %d mismatches; max |cpp_eval(ts_strategy) - ts_expl| = %.3g chips; max |cpp_expl - ts_expl| "
              "after the same iterations = %.3g chips\n",
              nspots, fails, worst_expl_diff, worst_iter_diff);
  return fails ? 1 : 0;
}

}  // namespace rt
}  // namespace bp
