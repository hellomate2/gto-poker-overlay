// ============================================================
// search.cpp: see search.h.
// ============================================================
#include "search.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <thread>

#include <sys/resource.h>

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

// ---- rule-based builder (off-tree sizes) --------------------------------------------

namespace {

struct RState {
  int32_t c[2];
  int street, player, raises, actions;
  int32_t last_inc;
};
struct RAct {
  uint8_t kind;
  int32_t to;
  std::string label;
};

std::string frac_label(char k, double f) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%c%g", k, f);
  return buf;
}

// Port of tree.cpp legal_actions (keep in sync), labels as BettingTree::token.
void rule_actions(const TreeConfig& cfg, const RState& s, std::vector<RAct>& out) {
  out.clear();
  const StreetRules& r = cfg.street[s.street];
  int p = s.player, o = 1 - p;
  int32_t mine = s.c[p], theirs = s.c[o], maxc = std::max(mine, theirs);
  int32_t to_call = maxc - mine, pot = s.c[0] + s.c[1];
  if (to_call > 0) {
    out.push_back({ACT_FOLD, mine, "f"});
    out.push_back({ACT_CALL, std::min(maxc, cfg.stack), "c"});
  } else {
    out.push_back({ACT_CHECK, mine, "k"});
  }
  bool chips_behind = theirs < cfg.stack && mine + to_call < cfg.stack;
  if (!chips_behind) return;
  if (s.raises >= r.max_raises) {
    if (!r.limit && r.allin) out.push_back({ACT_ALLIN, cfg.stack, "a"});
    return;
  }
  uint8_t kind = to_call > 0 ? ACT_RAISE : ACT_BET;
  if (r.limit) die("search: rule builder is for no-limit trees");
  const std::vector<float>& fr = to_call > 0 ? r.raise_fracs : r.bet_fracs;
  std::vector<int32_t> seen;
  for (float f : fr) {
    int32_t to;
    if (to_call == 0) to = mine + std::max(cfg.min_bet, int32_t(std::lround(f * pot)));
    else to = maxc + std::max(s.last_inc, int32_t(std::lround(f * (pot + to_call))));
    if (to >= cfg.stack) {
      if (r.allin) continue;
      to = cfg.stack;
    }
    if (std::find(seen.begin(), seen.end(), to) != seen.end()) continue;
    seen.push_back(to);
    out.push_back({kind, to, frac_label(kind == ACT_BET ? 'b' : 'r', std::lround(f * 1000) / 1000.0)});
  }
  if (r.allin && std::find(seen.begin(), seen.end(), cfg.stack) == seen.end())
    out.push_back({ACT_ALLIN, cfg.stack, "a"});
}

// The extra action a token such as "b0.8" or "r2.5" names at state s.
bool token_action(const TreeConfig& cfg, const RState& s, const std::string& tok, RAct& out) {
  if (tok.size() < 2 || (tok[0] != 'b' && tok[0] != 'r')) return false;
  double f = std::stod(tok.substr(1));
  int p = s.player, o = 1 - p;
  int32_t mine = s.c[p], theirs = s.c[o], maxc = std::max(mine, theirs);
  int32_t to_call = maxc - mine, pot = s.c[0] + s.c[1];
  if ((tok[0] == 'b') != (to_call == 0)) return false;
  if (!(theirs < cfg.stack && mine + to_call < cfg.stack)) return false;
  int32_t to = to_call == 0 ? mine + std::max(cfg.min_bet, int32_t(std::lround(f * pot)))
                            : maxc + std::max(s.last_inc, int32_t(std::lround(f * (pot + to_call))));
  if (to >= cfg.stack) return false;  // that is the all-in, token "a"
  out = {uint8_t(to_call == 0 ? ACT_BET : ACT_RAISE), to, tok};
  return true;
}

struct RuleBuilder {
  Game& g;
  const BpView& bv;
  const TreeConfig& cfg;
  int32_t base[2];
  const std::vector<std::string>& line;

  SNode make(const RState& s, int parent, const std::vector<int>& board) {
    SNode k;
    k.parent = parent;
    k.c[0] = s.c[0] - base[0];
    k.c[1] = s.c[1] - base[1];
    k.pot = g.pot0 + k.c[0] + k.c[1];
    k.board = g.add_board(board);
    return k;
  }

  // depth = position in `line` if this node is on the actual line, else -1
  void expand(int idx, const RState& s, const std::vector<int>& board, int depth) {
    std::vector<RAct> acts;
    rule_actions(cfg, s, acts);
    if (depth >= 0 && depth < int(line.size())) {
      bool have = false;
      for (auto& a : acts) have |= a.label == line[depth];
      RAct extra;
      if (!have) {
        if (!token_action(cfg, s, line[depth], extra))
          die("search: token '" + line[depth] + "' is not a legal action at this point of the line");
        bool dup = false;
        for (auto& a : acts) dup |= a.to == extra.to && a.kind == extra.kind;
        if (dup) die("search: token '" + line[depth] + "' duplicates an existing size");
        // keep sizes ordered: insert before the first larger bet/raise or the all-in
        size_t pos = acts.size();
        for (size_t x = 0; x < acts.size(); x++)
          if ((acts[x].kind == ACT_BET || acts[x].kind == ACT_RAISE || acts[x].kind == ACT_ALLIN) && acts[x].to > extra.to) {
            pos = x;
            break;
          }
        acts.insert(acts.begin() + long(pos), extra);
      }
    }
    struct Kid {
      RState t;
      uint8_t type;
      bool next_street;
    };
    std::vector<Kid> kids;
    const int p = s.player, o = 1 - p;
    int first = int(g.nodes.size());
    for (const RAct& A : acts) {
      RState t = s;
      bool to_next = false, showdown = false;
      uint8_t type = S_DEC;
      if (A.kind == ACT_FOLD) {
        type = S_FOLD;
      } else if (A.kind == ACT_CHECK) {
        if (s.actions >= 1) to_next = true;
      } else if (A.kind == ACT_CALL) {
        t.c[p] = A.to;
        if (t.c[p] >= cfg.stack || t.c[o] >= cfg.stack) showdown = true;
        else if (s.actions >= 1) to_next = true;
      } else {
        int32_t maxc = std::max(s.c[0], s.c[1]);
        t.last_inc = std::max(s.last_inc, A.to - maxc);
        t.c[p] = A.to;
        t.raises = s.raises + 1;
      }
      t.actions = s.actions + 1;
      t.player = o;
      if (to_next) {
        if (s.street + 1 >= cfg.nstreets) showdown = true;
        else {
          t.street = s.street + 1;
          t.raises = 0;
          t.actions = 0;
          t.last_inc = cfg.min_bet;
          t.player = cfg.street[t.street].first_player;
        }
      }
      if (showdown) type = S_SHOW;
      else if (to_next) type = S_CHANCE;
      SNode k = make(t, idx, board);
      k.type = type;
      k.player = uint8_t(type == S_FOLD ? p : type == S_DEC ? t.player : 0);
      k.label = A.label;
      add_node(g, k);
      kids.push_back({t, type, to_next});
    }
    g.nodes[idx].type = S_DEC;
    g.nodes[idx].player = uint8_t(p);
    g.nodes[idx].first = first;
    g.nodes[idx].nact = int(acts.size());
    for (size_t a = 0; a < kids.size(); a++) {
      int ch = first + int(a);
      int d2 = depth >= 0 && depth < int(line.size()) && acts[a].label == line[depth] ? depth + 1 : -1;
      if (kids[a].type == S_DEC) expand(ch, kids[a].t, board, d2);
      else if (kids[a].type == S_CHANCE) expand_chance(ch, kids[a].t, board);
    }
  }

  void expand_chance(int idx, const RState& t, const std::vector<int>& board) {
    if (bv.board_len[t.street] - int(board.size()) != 1) die("search: rule builder deals one card per street");
    uint64_t bm = 0;
    for (int c : board) bm |= 1ull << c;
    std::vector<int> cards;
    for (int x = 0; x < bv.deck; x++)
      if (!(bm >> x & 1)) cards.push_back(x);
    int first = int(g.nodes.size());
    for (int x : cards) {
      std::vector<int> b2 = board;
      b2.push_back(x);
      SNode k = make(t, idx, b2);
      k.type = S_DEC;
      k.player = uint8_t(t.player);
      k.deal = x;
      k.label = bv.deck == 52 ? card_str(x) : "d" + std::to_string(x);
      add_node(g, k);
    }
    g.nodes[idx].first = first;
    g.nodes[idx].nact = int(cards.size());
    for (size_t k = 0; k < cards.size(); k++) {
      std::vector<int> b2 = board;
      b2.push_back(cards[k]);
      expand(first + int(k), t, b2, -1);
    }
  }
};

}  // namespace

void build_by_rules(Game& g, const BpView& bv, uint32_t root, const std::vector<int>& board,
                    const std::vector<std::string>& line) {
  const BettingTree& tr = *bv.tree;
  const Node& r = tr.nodes[root];
  if (r.type != DECISION) die("search: subgame root must be a decision node");
  if (root != round_start(tr, root)) die("search: rule builder starts at the first node of a round");
  g.nodes.clear();
  g.boards.clear();
  g.leaves.clear();
  g.deck = bv.deck;
  g.cards_per_hand = bv.cards_per_hand;
  g.full_board = bv.board_len.back();
  g.strength = bv.strength;
  g.pot0 = double(r.contrib[0] + r.contrib[1]);
  RState s;
  s.c[0] = r.contrib[0];
  s.c[1] = r.contrib[1];
  s.street = r.street;
  s.player = r.player;
  s.raises = 0;
  s.actions = 0;
  s.last_inc = tr.cfg.min_bet;
  RuleBuilder b{g, bv, tr.cfg, {r.contrib[0], r.contrib[1]}, line};
  SNode n = b.make(s, -1, board);
  add_node(g, n);
  b.expand(0, s, board, 0);
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

double cpu_seconds() {
  struct rusage ru;
  getrusage(RUSAGE_SELF, &ru);
  return ru.ru_utime.tv_sec + ru.ru_utime.tv_usec * 1e-6 + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec * 1e-6;
}

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
  // Off-tree mode: `line` holds the tokens from the round start to the
  // decision, at least one of which is not in the blueprint; `node` is unused.
  bool offtree = false;
  std::vector<std::string> line;
  uint32_t node = 0, rs = 0;
  std::vector<int> board;
  int hero = 0;
  Hand hero_hand;
};

struct SearchOut {
  std::vector<std::string> labels;
  std::vector<double> strat, bp_strat;
  double expl = 0, pot0 = 0, setup_s = 0, solve_s = 0, setup_cpu = 0, solve_cpu = 0;
  int iters = 0, H[2] = {0, 0}, leaves = 0, nodes = 0;
};

// One search: ranges from the blueprint, subgame from the round start,
// solve under the budget, return the hero hand's strategy at `node`.
SearchOut run_search(const BpView& bv, const SearchSpot& sp, int k, double bias, size_t max_hands, int rollouts,
                     double budget_s, int max_iters, int threads, uint64_t seed, bool want_expl,
                     SolverConfig sc = SolverConfig{},
                     std::map<uint32_t, std::vector<double>>* plan = nullptr) {
  SearchOut o;
  const BettingTree& t = *bv.tree;
  double t0 = now_sec(), c0 = cpu_seconds();
  uint64_t bm = 0;
  for (int c : sp.board) bm |= 1ull << c;
  Game g;
  for (int p = 0; p < 2; p++) {
    g.hands[p] = all_combos(bm);
    g.w[p] = blueprint_reach(bv, g.hands[p], p, sp.rs, sp.board);
    cap_range(g.hands[p], g.w[p], max_hands, p == sp.hero ? 0 : -1, sp.hero_hand.mask);
  }
  const int street = t.nodes[sp.rs].street;
  std::vector<uint32_t> leaf_bp;
  if (sp.offtree) {
    if (street < 2) die("search: off-tree sizes are supported on the turn and river (flop leaves need blueprint nodes)");
    build_by_rules(g, bv, sp.rs, sp.board, sp.line);
  } else {
    leaf_bp = build_from_blueprint(g, bv, sp.rs, sp.board, street == 1);
  }
  g.finalize();
  if (!leaf_bp.empty()) build_leaf_values(g, bv, leaf_bp, sp.board, k, bias, rollouts, seed, threads);
  // Locate the decision node and the hero's own in-round actions.
  std::vector<int> acts;  // action index taken at each node of the line
  if (sp.offtree) {
    int c = 0;
    for (const std::string& tok : sp.line) {
      int a = -1;
      for (int x = 0; x < g.nodes[c].nact; x++)
        if (g.nodes[g.nodes[c].first + x].label == tok) a = x;
      if (a < 0 || g.nodes[c].type != S_DEC) die("search: line token '" + tok + "' not found in the subgame");
      acts.push_back(a);
      c = g.nodes[c].first + a;
    }
  } else {
    std::vector<uint32_t> path;
    for (uint32_t c = sp.node; c != sp.rs; c = t.nodes[c].parent) path.push_back(c);
    std::reverse(path.begin(), path.end());
    for (uint32_t c : path) acts.push_back(int(c - t.nodes[t.nodes[c].parent].child));
  }
  int cur = 0;
  int hero_idx = -1;
  for (int i = 0; i < g.n(sp.hero); i++)
    if (g.hands[sp.hero][i].mask == sp.hero_hand.mask) hero_idx = i;
  sc.threads = threads;
  Solver S(g, sc);
  for (int a : acts) {
    const SNode& nd = g.nodes[cur];
    if (nd.player == sp.hero && hero_idx >= 0) S.freeze(cur, hero_idx, a);
    cur = nd.first + a;
  }
  if (plan) {
    // Plan mode (search-h2h): solve from the round start and return the
    // hero hand's average strategy at every on-tree hero node of the round.
    while (S.iterations() < max_iters) S.iterate();
    o.iters = S.iterations();
    for (int x = 0; x < int(g.nodes.size()); x++)
      if (g.nodes[x].type == S_DEC && g.nodes[x].player == sp.hero && g.nodes[x].bp >= 0) {
        std::vector<double> st(g.nodes[x].nact);
        S.average(x, hero_idx, st.data());
        (*plan)[uint32_t(g.nodes[x].bp)] = st;
      }
    return o;
  }
  if (g.nodes[cur].type != S_DEC || g.nodes[cur].player != sp.hero) die("search: the line does not end at the hero's decision");
  if (!sp.offtree && g.nodes[cur].bp != int(sp.node)) die("search: subgame node does not match the blueprint node");
  o.setup_s = now_sec() - t0;
  o.setup_cpu = cpu_seconds() - c0;
  double t1 = now_sec(), c1 = cpu_seconds();
  while (S.iterations() < max_iters && (S.iterations() < 1 || now_sec() - t0 < budget_s)) S.iterate();
  o.solve_s = now_sec() - t1;
  o.solve_cpu = cpu_seconds() - c1;
  o.iters = S.iterations();
  const SNode& nd = g.nodes[cur];
  o.strat.resize(nd.nact);
  S.average(cur, hero_idx, o.strat.data());
  for (int a = 0; a < nd.nact; a++) o.labels.push_back(g.nodes[nd.first + a].label);
  if (!sp.offtree) {
    const Node& bn = t.nodes[sp.node];
    std::vector<int> pre(sp.board.begin(), sp.board.begin() + bv.board_len[bn.street]);
    o.bp_strat.resize(bn.nact);
    bv.policy(bn.slot + uint64_t(bv.bucket(sp.hero_hand, pre, bn.street)) * bn.nact, bn.nact, o.bp_strat.data());
  }
  if (want_expl) o.expl = S.exploitability();
  o.pot0 = g.pot0;
  o.H[0] = g.n(0);
  o.H[1] = g.n(1);
  o.leaves = int(leaf_bp.size());
  o.nodes = int(g.nodes.size());
  return o;
}

// One parsed search request. `bp search` (flags) and `bp serve` (a JSON
// "search" request with the same keys) both go through parse_search_request
// and run_search, so a served search equals the command-line search for the
// same spot and settings.
struct SearchRequest {
  SearchSpot sp;
  int street = 0;  // street of the round start
  int k = 4;
  double bias = 5;
  size_t cap = 0;
  int rollouts = 24;
  double budget_s = 2;
  int max_iters = 1000000;
  int threads = 4;
  uint64_t seed = 1;
  SolverConfig sc;
};

SearchRequest parse_search_request(const KV& a, const BettingTree& tree, const BpView& bv,
                                   double default_budget_ms = 2000, int default_threads = 4) {
  SearchRequest r;
  SearchSpot& sp = r.sp;
  sp.board = parse_cards(a.get("board"));
  std::vector<int> hh = parse_cards(a.get("hand"));
  if (hh.size() != 2) die("search: --hand needs two cards, e.g. 'Qs Qh'");
  if (hh[0] == hh[1]) die("search: the two hole cards are the same card");
  for (int c : sp.board)
    if (c == hh[0] || c == hh[1]) die("search: a hole card is also on the board");
  sp.hero_hand.c[0] = hh[0];
  sp.hero_hand.c[1] = hh[1];
  sp.hero_hand.nc = 2;
  sp.hero_hand.mask = (1ull << hh[0]) | (1ull << hh[1]);
  std::vector<std::string> toks = split_ws(a.get("history"));
  int64_t ni = tree.find(toks);
  if (ni < 0) {
    // Off-tree: follow the blueprint as far as it goes; the rest of the line
    // must stay inside the current round and is added to the subgame.
    size_t m = 0;
    uint32_t u = 0;
    while (m < toks.size()) {
      std::vector<std::string> pre(toks.begin(), toks.begin() + long(m) + 1);
      int64_t x = tree.find(pre);
      if (x < 0) break;
      u = uint32_t(x);
      m++;
    }
    if (tree.nodes[u].type != DECISION) die("search: history not found in the blueprint tree");
    sp.offtree = true;
    sp.rs = round_start(tree, u);
    std::vector<std::string> in_round;
    for (uint32_t c = u; c != sp.rs; c = tree.nodes[c].parent) in_round.push_back(tree.token(c));
    std::reverse(in_round.begin(), in_round.end());
    for (size_t x = m; x < toks.size(); x++) in_round.push_back(toks[x]);
    sp.line = in_round;
    sp.node = u;
    if (tree.nodes[sp.rs].street < 2)
      die("search: off-tree sizes are supported on the turn and river (flop leaves need blueprint nodes)");
    if (int(sp.board.size()) != bv.board_len[tree.nodes[sp.rs].street])
      die("search: board size does not match the street of the history");
    // the player to act after the line: replay it on a throwaway rule build
    Game probe;
    for (int p = 0; p < 2; p++) probe.hands[p].clear();
    build_by_rules(probe, bv, sp.rs, sp.board, sp.line);
    int c = 0;
    for (const std::string& tk : sp.line) {
      int nx = -1;
      for (int x = 0; x < probe.nodes[c].nact; x++)
        if (probe.nodes[probe.nodes[c].first + x].label == tk) {
          nx = probe.nodes[c].first + x;
          break;
        }
      if (nx < 0) die("search: token '" + tk + "' is not an action of the rebuilt round");
      c = nx;
    }
    if (probe.nodes[c].type != S_DEC) die("search: the history does not end at a decision");
    sp.hero = probe.nodes[c].player;
  } else {
    if (tree.nodes[ni].type != DECISION) die("search: history ends at a terminal node");
    sp.node = uint32_t(ni);
    sp.hero = tree.nodes[ni].player;
    sp.rs = round_start(tree, sp.node);
  }
  const Node& n = tree.nodes[sp.rs];
  if (n.street == 0) die("search: preflop search is not implemented (play the blueprint preflop)");
  if (int(sp.board.size()) != bv.board_len[n.street]) die("search: board size does not match the street of the history");
  r.street = n.street;
  r.k = int(a.i("k", 4));
  r.cap = size_t(a.i("max-hands", n.street == 1 ? 120 : n.street == 2 ? 300 : 1326));
  std::string algo = a.get("algo", "dcfr");
  if (algo == "cfr+") {
    r.sc.algo = SolverConfig::CFRPLUS;
    r.sc.cfrp_delay = int(a.i("cfrp-delay", 0));
  } else if (algo == "dcfr") {
    r.sc.alpha = a.f("alpha", 1.5);
    r.sc.beta = a.f("beta", 0.5);
    r.sc.gamma = a.f("gamma", 2.0);
  } else {
    die("search: --algo must be dcfr or cfr+");
  }
  r.bias = a.f("bias", 5);
  r.rollouts = int(a.i("rollouts", 24));
  r.budget_s = a.f("budget-ms", default_budget_ms) / 1000.0;
  r.max_iters = int(a.i("max-iters", 1000000));
  r.threads = int(a.i("threads", default_threads));
  r.seed = uint64_t(a.i("seed", 1));
  if (r.threads < 1 || r.threads > 64) die("search: threads must be 1..64");
  if (r.max_iters < 1) die("search: max-iters must be at least 1");
  return r;
}

SearchOut run_request(const BpView& bv, const SearchRequest& r, bool want_expl) {
  return run_search(bv, r.sp, r.k, r.bias, r.cap, r.rollouts, r.budget_s, r.max_iters, r.threads, r.seed, want_expl,
                    r.sc);
}

int cmd_search(const KV& a, const BettingTree& tree, const Abstraction& abs, const std::vector<float>& pol) {
  BpView bv = holdem_view(tree, abs, pol);
  SearchRequest r = parse_search_request(a, tree, bv);
  const SearchSpot& sp = r.sp;
  const int k = r.k;
  const Node& n = tree.nodes[sp.rs];
  SearchOut o = run_request(bv, r, true);
  std::string ln;
  for (auto& x : sp.line) ln += (ln.empty() ? "" : " ") + x;
  std::printf("search: street %d, player %d to act, history '%s', round start '%s'%s%s\n", n.street, sp.hero,
              a.get("history").c_str(), tree.history(sp.rs).c_str(), sp.offtree ? ", off-tree line in round: " : "",
              ln.c_str());
  std::printf("subgame: %d nodes, %d depth-limit leaves (k=%d), hands %d vs %d, pot0 %.0f\n", o.nodes, o.leaves,
              o.leaves ? k : 0, o.H[0], o.H[1], o.pot0);
  std::printf("setup %.3fs, solve %.3fs, %d iterations, exploitability %.2f chips (%.3f%% of pot0, within the "
              "subgame model)\n",
              o.setup_s, o.solve_s, o.iters, o.expl, 100 * o.expl / o.pot0);
  std::printf("cpu time (all threads): setup %.3fs, solve %.3fs (%.2f ms of cpu per iteration)\n", o.setup_cpu,
              o.solve_cpu, 1000 * o.solve_cpu / std::max(1, o.iters));
  std::printf("%-8s %8s %8s\n", "action", "search", "blueprint");
  for (size_t x = 0; x < o.labels.size(); x++) {
    if (o.bp_strat.empty()) std::printf("%-8s %8.4f %8s\n", o.labels[x].c_str(), o.strat[x], "-");
    else std::printf("%-8s %8.4f %8.4f\n", o.labels[x].c_str(), o.strat[x], o.bp_strat[x]);
  }
  if (a.has("json")) {
    // Machine-readable copy of the result (same fields as a serve "search"
    // reply), used by the serve/CLI parity test.
    std::printf("json: {\"labels\":[");
    for (size_t x = 0; x < o.labels.size(); x++) std::printf("%s\"%s\"", x ? "," : "", o.labels[x].c_str());
    std::printf("],\"probs\":[");
    for (size_t x = 0; x < o.strat.size(); x++) std::printf("%s%.17g", x ? "," : "", o.strat[x]);
    std::printf("],\"iters\":%d}\n", o.iters);
  }
  return 0;
}

// Search agent vs pure blueprint, searching one street.
//
// Estimator. Both agents play the blueprint before the searched street, so
// for a fixed deal and a fixed stream of action samples they reach the same
// spot at the start of that street. There the searcher solves the round from
// its start (unsafe, beliefs from the blueprint reach of both players) and
// keeps that plan for the rest of the round; later streets are blueprint.
// The hand's value is computed EXACTLY by walking the rest of the tree with
// the deal's cards fixed:
//   delta = EV(searcher's plan, then blueprint) - EV(blueprint vs blueprint)
// and delta = 0 for hands that end earlier. Blueprint vs blueprint is worth
// exactly 0 over the two seats of a duplicate deal, so the mean of delta
// (averaged over both seats per deal) is an unbiased estimate of the
// searcher's win rate against the blueprint, without the action-sampling
// noise of the searched street and after it (a control variate with known
// mean). Several k values run on the same deals, so their difference is a
// paired comparison.
int cmd_search_h2h(const KV& a, const BettingTree& tree, const Abstraction& abs, const std::vector<float>& pol) {
  BpView bv = holdem_view(tree, abs, pol);
  const int64_t deals = a.i("hands", 1000);
  const int threads = int(a.i("threads", 4));
  const int iters = int(a.i("iters", 200));
  const int street = int(a.i("street", 3));
  if (street < 1 || street > 3) die("search-h2h: --street must be 1 (flop), 2 (turn) or 3 (river)");
  const size_t max_hands = size_t(a.i("max-hands", street == 1 ? 120 : street == 2 ? 300 : 1326));
  const int rollouts = int(a.i("rollouts", 24));
  const uint64_t seed = uint64_t(a.i("seed", 7));
  std::vector<int> klist;
  {
    std::stringstream ss(a.get("k-list", street == 1 ? "4" : "1"));
    std::string t;
    while (std::getline(ss, t, ','))
      if (!t.empty()) klist.push_back(std::stoi(t));
  }
  const size_t K = klist.size();
  HoldemSampler smp{&abs};
  // per thread: sums and squares per k, and of (k_last - k_first)
  std::vector<std::vector<double>> sum(threads, std::vector<double>(K + 1, 0)), sq(threads, std::vector<double>(K + 1, 0));
  std::vector<double> stime(threads, 0);
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
        std::vector<double> rk(K, 0.0);
        for (int seat = 0; seat < 2; seat++) {  // seat = the searcher's position
          uint32_t ni = 0;
          double sig[MAX_ACTIONS];
          while (tree.nodes[ni].type == DECISION && tree.nodes[ni].street < street) {
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
          if (tree.nodes[ni].type != DECISION) continue;  // ended before the searched street: delta 0
          const uint32_t rs = ni;
          double ts = now_sec();
          SearchSpot sp;
          sp.board.assign(board.begin(), board.begin() + bv.board_len[street]);
          sp.hero = seat;
          sp.hero_hand.c[0] = d.hole[seat][0];
          sp.hero_hand.c[1] = d.hole[seat][1];
          sp.hero_hand.nc = 2;
          sp.hero_hand.mask = (1ull << sp.hero_hand.c[0]) | (1ull << sp.hero_hand.c[1]);
          sp.rs = rs;
          sp.node = rs;
          std::vector<std::map<uint32_t, std::vector<double>>> plans(K);
          for (size_t v = 0; v < K; v++)
            run_search(bv, sp, klist[v], 5.0, max_hands, rollouts, 1e9, iters, 1, seed * 31 + uint64_t(i), false,
                       SolverConfig{}, &plans[v]);
          stime[th] += now_sec() - ts;
          nsearch[th]++;
          // Exact EV over every remaining action with the deal's cards fixed;
          // plan == nullptr is the blueprint baseline.
          std::function<double(uint32_t, const std::map<uint32_t, std::vector<double>>*)> ev =
              [&](uint32_t v, const std::map<uint32_t, std::vector<double>>* plan) -> double {
            const Node& nd = tree.nodes[v];
            if (nd.type != DECISION) return terminal_utility(nd, seat, d.winner);
            double pr[MAX_ACTIONS];
            bool own = false;
            if (plan && nd.player == seat) {
              auto it = plan->find(v);
              if (it != plan->end()) {
                for (int x = 0; x < nd.nact; x++) pr[x] = it->second[x];
                own = true;
              }
            }
            if (!own) bv.policy(nd.slot + uint64_t(d.bucket[nd.player][nd.street]) * nd.nact, nd.nact, pr);
            double s2 = 0;
            for (int x = 0; x < nd.nact; x++)
              if (pr[x] > 0) s2 += pr[x] * ev(nd.child + x, plan);
            return s2;
          };
          double base = ev(rs, nullptr);
          for (size_t v = 0; v < K; v++) rk[v] += ev(rs, &plans[v]) - base;
        }
        for (size_t v = 0; v < K; v++) {
          double r = 0.5 * rk[v];
          sum[th][v] += r;
          sq[th][v] += r * r;
        }
        double dlt = 0.5 * (rk[K - 1] - rk[0]);
        sum[th][K] += dlt;
        sq[th][K] += dlt * dlt;
      }
    });
  for (auto& p : pool) p.join();
  double T = 0;
  int64_t NS = 0;
  for (int t = 0; t < threads; t++) T += stime[t], NS += nsearch[t];
  const char* sname = street == 1 ? "flop" : street == 2 ? "turn" : "river";
  for (size_t v = 0; v <= K; v++) {
    if (v == K && K < 2) break;
    double S = 0, Q = 0;
    for (int t = 0; t < threads; t++) S += sum[t][v], Q += sq[t][v];
    double mean = S / deals, var = Q / deals - mean * mean, ci = 1.96 * std::sqrt(var / deals);
    if (v < K)
      std::printf("search-h2h: blueprint + %s search (k=%d, %d DCFR iterations, unsafe, from the round start) vs "
                  "blueprint: %+.1f mbb/hand (95%% CI +/- %.1f, %lld duplicate deals = %lld hands, exact EV)\n",
                  sname, street == 1 ? klist[v] : 0, iters, mean * 10, ci * 10, (long long)deals,
                  (long long)deals * 2);
    else
      std::printf("search-h2h: paired difference k=%d minus k=%d: %+.1f mbb/hand (95%% CI +/- %.1f)\n", klist[K - 1],
                  klist[0], mean * 10, ci * 10);
  }
  std::printf("%s searches %lld (each solves %zu k value(s)), mean %.3fs per search (thread time), wall %.1fs\n", sname,
              (long long)NS, K, NS ? T / NS : 0.0, now_sec() - t_start);
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

// `bp serve` "search" request (see search.h). Keys are the `bp search` flag
// names; "hole" is accepted for "hand". Serve-only keys: "min-iters" (the
// reply's "complete" is false when the budget ran out before that many
// iterations; the client then plays the blueprint) and "expl" (1 = also
// report the subgame exploitability, computed after the budget).
std::string serve_search(const BettingTree& tree, const BpView& bv, const std::map<std::string, std::string>& req) {
  std::map<std::string, std::string> kv = req;
  if (!kv.count("hand") && kv.count("hole")) kv["hand"] = kv["hole"];
  KV a{kv};
  const double t0 = now_sec();
  SearchRequest r = parse_search_request(a, tree, bv, 1500, 1);
  const bool want_expl = a.i("expl", 0) != 0;
  SearchOut o = run_request(bv, r, want_expl);
  const double total_ms = 1000 * (now_sec() - t0);
  const int min_iters = int(a.i("min-iters", 0));
  std::ostringstream out;
  char buf[48];
  auto num = [&](double v) {
    std::snprintf(buf, sizeof buf, "%.17g", v);
    return std::string(buf);
  };
  std::string ln;
  for (auto& x : r.sp.line) ln += (ln.empty() ? "" : " ") + x;
  out << ",\"street\":" << r.street << ",\"player\":" << r.sp.hero << ",\"offtree\":" << (r.sp.offtree ? "true" : "false")
      << ",\"round_start\":\"" << tree.history(r.sp.rs) << "\",\"line\":\"" << ln << "\",\"labels\":[";
  for (size_t x = 0; x < o.labels.size(); x++) out << (x ? "," : "") << "\"" << o.labels[x] << "\"";
  out << "],\"probs\":[";
  for (size_t x = 0; x < o.strat.size(); x++) out << (x ? "," : "") << num(o.strat[x]);
  out << "],\"bp_probs\":[";
  for (size_t x = 0; x < o.bp_strat.size(); x++) out << (x ? "," : "") << num(o.bp_strat[x]);
  out << "],\"iters\":" << o.iters << ",\"complete\":" << (o.iters >= min_iters ? "true" : "false")
      << ",\"hands\":[" << o.H[0] << "," << o.H[1] << "],\"nodes\":" << o.nodes << ",\"setup_ms\":"
      << num(1000 * o.setup_s) << ",\"solve_ms\":" << num(1000 * o.solve_s) << ",\"ms\":" << num(total_ms);
  if (want_expl) out << ",\"expl_pct\":" << num(100 * o.expl / o.pot0);
  return out.str();
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
