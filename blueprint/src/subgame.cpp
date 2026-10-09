// ============================================================
// subgame.cpp: see subgame.h.
// ============================================================
#include "subgame.h"

#include <algorithm>
#include <cmath>
#include <map>

#include "eval.h"

namespace bp {
namespace rt {

// ---- Game -----------------------------------------------------------------------

int Game::add_board(const std::vector<int>& cards) {
  std::vector<int> s = cards;
  std::sort(s.begin(), s.end());
  for (size_t i = 0; i < boards.size(); i++)
    if (boards[i].cards == s) return int(i);
  Board b;
  b.cards = s;
  for (int c : s) b.mask |= 1ull << c;
  boards.push_back(b);
  return int(boards.size() - 1);
}

int add_node(Game& g, const SNode& n) {
  g.nodes.push_back(n);
  return int(g.nodes.size() - 1);
}

int32_t holdem_strength(const Hand& h, const std::vector<int>& board) {
  uint64_t bm = 0;
  for (int c : board) bm |= 1ull << c;
  if (h.mask & bm) return -1;
  int cards[7] = {h.c[0], h.c[1], board[0], board[1], board[2], board[3], board[4]};
  return int32_t(eval_n(cards, 7));
}

double Game::joint_mass() const {
  double z = 0;
  const int H0 = n(0), H1 = n(1);
  for (int i = 0; i < H0; i++) {
    double row = 0;
    for (int j = 0; j < H1; j++) row += compat[size_t(i) * H1 + j] * w[1][j];
    z += w[0][i] * row;
  }
  return z;
}

std::string Game::line(int node) const {
  std::vector<std::string> t;
  while (node > 0) {
    t.push_back(nodes[node].label);
    node = nodes[node].parent;
  }
  std::string s;
  for (size_t k = t.size(); k-- > 0;) s += (s.empty() ? "" : "/") + t[k];
  return s;
}

int Game::find(const std::vector<std::string>& labels) const {
  int cur = 0;
  for (const auto& l : labels) {
    const SNode& nd = nodes[cur];
    if (nd.type != S_DEC && nd.type != S_CHANCE) return -1;
    int nx = -1;
    for (int a = 0; a < nd.nact; a++)
      if (nodes[nd.first + a].label == l) nx = nd.first + a;
    if (nx < 0) return -1;
    cur = nx;
  }
  return cur;
}

void Game::finalize() {
  for (int p = 0; p < 2; p++) {
    for (auto& h : hands[p]) {
      h.mask = 0;
      for (int k = 0; k < h.nc; k++) h.mask |= 1ull << h.c[k];
    }
    double s = 0;
    for (double x : w[p]) s += x;
    if (!(s > 0)) die("subgame: empty range for player " + std::to_string(p));
    for (double& x : w[p]) x /= s;
  }
  for (int p = 0; p < 2; p++) {
    std::map<uint64_t, int> idx;
    for (int j = 0; j < n(1 - p); j++) idx[hands[1 - p][j].mask] = j;
    same[p].assign(n(p), -1);
    if (cards_per_hand == 2)
      for (int i = 0; i < n(p); i++) {
        auto it = idx.find(hands[p][i].mask);
        if (it != idx.end()) same[p][i] = it->second;
      }
  }
  const int H0 = n(0), H1 = n(1);
  compat.assign(size_t(H0) * H1, 0.f);
  for (int i = 0; i < H0; i++)
    for (int j = 0; j < H1; j++)
      compat[size_t(i) * H1 + j] = (hands[0][i].mask & hands[1][j].mask) ? 0.f : 1.f;
  num_slots = 0;
  std::vector<char> used(boards.size(), 0);
  for (auto& nd : nodes) {
    if (nd.type == S_DEC) {
      nd.off = num_slots;
      num_slots += size_t(nd.nact) * n(nd.player);
    }
    if (nd.type == S_SHOW) used[nd.board] = 1;
  }
  // Showdown tables.
  for (size_t bi = 0; bi < boards.size(); bi++) {
    if (!used[bi]) continue;
    Board& b = boards[bi];
    if (int(b.cards.size()) >= full_board) {
      if (!strength) die("subgame: sweep showdown needs a strength function");
      b.sweep = true;
      for (int p = 0; p < 2; p++) {
        b.str[p].assign(n(p), -1);
        b.asc[p].clear();
        for (int i = 0; i < n(p); i++) {
          b.str[p][i] = (hands[p][i].mask & b.mask) ? -1 : strength(hands[p][i], b.cards);
          if (b.str[p][i] >= 0) b.asc[p].push_back(i);
        }
        const auto& st = b.str[p];
        std::stable_sort(b.asc[p].begin(), b.asc[p].end(), [&](int x, int y) { return st[x] < st[y]; });
      }
    } else {
      // Equity matrix over every completion of the board.
      b.equity = true;
      int need = full_board - int(b.cards.size());
      std::vector<int> live;
      for (int c = 0; c < deck; c++)
        if (!(b.mask >> c & 1)) live.push_back(c);
      std::vector<double> win(size_t(H0) * H1, 0.0), cnt(size_t(H0) * H1, 0.0);
      std::vector<int32_t> s0(H0), s1(H1);
      auto run = [&](const std::vector<int>& extra) {
        std::vector<int> full = b.cards;
        uint64_t em = 0;
        for (int c : extra) full.push_back(c), em |= 1ull << c;
        for (int i = 0; i < H0; i++) s0[i] = (hands[0][i].mask & (em | b.mask)) ? -1 : strength(hands[0][i], full);
        for (int j = 0; j < H1; j++) s1[j] = (hands[1][j].mask & (em | b.mask)) ? -1 : strength(hands[1][j], full);
        for (int i = 0; i < H0; i++) {
          if (s0[i] < 0) continue;
          for (int j = 0; j < H1; j++) {
            size_t k = size_t(i) * H1 + j;
            if (s1[j] < 0 || compat[k] == 0.f) continue;
            win[k] += s0[i] > s1[j] ? 1.0 : s0[i] < s1[j] ? 0.0 : 0.5;
            cnt[k] += 1;
          }
        }
      };
      if (need == 1) {
        for (int x : live) run({x});
      } else if (need == 2) {
        for (size_t x = 0; x < live.size(); x++)
          for (size_t y = x + 1; y < live.size(); y++) run({live[x], live[y]});
      } else {
        die("subgame: equity showdown supports at most 2 cards to come");
      }
      b.share.assign(size_t(H0) * H1, 0.0);
      for (size_t k = 0; k < b.share.size(); k++)
        b.share[k] = compat[k] == 0.f ? 0.0 : cnt[k] > 0 ? win[k] / cnt[k] : 0.5;
    }
  }
}

// ---- Solver ---------------------------------------------------------------------

Solver::Solver(Game& g, const SolverConfig& cfg) : g_(g), cfg_(cfg) {
  R_.assign(g.num_slots, 0.0);
  S_.assign(g.num_slots, 0.0);
  size_t lo = 0;
  for (int p = 0; p < 2; p++) leaf_off_[p].assign(g.leaves.size(), 0);
  for (size_t l = 0; l < g.leaves.size(); l++)
    for (int p = 0; p < 2; p++) {
      leaf_off_[p][l] = lo;
      lo += size_t(g.leaves[l].k[p]) * g.n(p);
    }
  // Leaves can be reached from several S_LEAF nodes only if they share a
  // LeafValues entry; each S_LEAF node owns its own regrets, so allocate per
  // node instead when indices repeat.
  LR_.assign(lo, 0.0);
  LS_.assign(lo, 0.0);
  cardsum_.assign(64, 0.0);
}

void Solver::freeze(int node, int h, int a) {
  frozen_node_.push_back(node);
  frozen_hand_.push_back(h);
  frozen_act_.push_back(a);
}

void Solver::regret_match(const double* R, int na, int n, double* out) const {
  for (int i = 0; i < n; i++) {
    double pos = 0;
    for (int a = 0; a < na; a++) pos += R[size_t(a) * n + i] > 0 ? R[size_t(a) * n + i] : 0;
    if (pos > 0) {
      for (int a = 0; a < na; a++) {
        double r = R[size_t(a) * n + i];
        out[size_t(a) * n + i] = r > 0 ? r / pos : 0;
      }
    } else {
      for (int a = 0; a < na; a++) out[size_t(a) * n + i] = 1.0 / na;
    }
  }
}

void Solver::apply_frozen(int ni, std::vector<double>& sig) const {
  const SNode& nd = g_.nodes[ni];
  const int n = g_.n(nd.player);
  for (size_t k = 0; k < frozen_node_.size(); k++)
    if (frozen_node_[k] == ni)
      for (int a = 0; a < nd.nact; a++) sig[size_t(a) * n + frozen_hand_[k]] = a == frozen_act_[k] ? 1.0 : 0.0;
}

void Solver::node_current(int ni, std::vector<double>& sig) const {
  const SNode& nd = g_.nodes[ni];
  const int n = g_.n(nd.player);
  sig.resize(size_t(nd.nact) * n);
  regret_match(&R_[nd.off], nd.nact, n, sig.data());
  apply_frozen(ni, sig);
}

void Solver::node_average(int ni, std::vector<double>& sig) const {
  const SNode& nd = g_.nodes[ni];
  const int n = g_.n(nd.player), na = nd.nact;
  sig.resize(size_t(na) * n);
  if (external) {
    std::vector<double> tmp(na);
    for (int i = 0; i < n; i++) {
      external(ni, i, tmp.data());
      for (int a = 0; a < na; a++) sig[size_t(a) * n + i] = tmp[a];
    }
    return;
  }
  const double* S = &S_[nd.off];
  for (int i = 0; i < n; i++) {
    double t = 0;
    for (int a = 0; a < na; a++) t += S[size_t(a) * n + i];
    for (int a = 0; a < na; a++) sig[size_t(a) * n + i] = t > 0 ? S[size_t(a) * n + i] / t : 1.0 / na;
  }
  apply_frozen(ni, sig);
}

void Solver::average(int node, int h, double* out) const {
  std::vector<double> sig;
  node_average(node, sig);
  const int n = g_.n(g_.nodes[node].player);
  for (int a = 0; a < g_.nodes[node].nact; a++) out[a] = sig[size_t(a) * n + h];
}

void Solver::current(int node, int h, double* out) const {
  std::vector<double> sig;
  node_current(node, sig);
  const int n = g_.n(g_.nodes[node].player);
  for (int a = 0; a < g_.nodes[node].nact; a++) out[a] = sig[size_t(a) * n + h];
}

void Solver::leaf_average(int node, int p, int h, double* out) const {
  const SNode& nd = g_.nodes[node];
  const int k = g_.leaves[nd.leaf].k[p], n = g_.n(p);
  const double* S = &LS_[leaf_off_[p][nd.leaf]];
  double t = 0;
  for (int a = 0; a < k; a++) t += S[size_t(a) * n + h];
  for (int a = 0; a < k; a++) out[a] = t > 0 ? S[size_t(a) * n + h] / t : 1.0 / k;
}

void Solver::mass(int p, const std::vector<double>& r, std::vector<double>& out) {
  const int q = 1 - p, n = g_.n(p), no = g_.n(q);
  out.assign(n, 0.0);
  double tot = 0;
  std::fill(cardsum_.begin(), cardsum_.end(), 0.0);
  const auto& oh = g_.hands[q];
  for (int j = 0; j < no; j++) {
    double x = r[j];
    if (x == 0) continue;
    tot += x;
    for (int k = 0; k < oh[j].nc; k++) cardsum_[oh[j].c[k]] += x;
  }
  const auto& mh = g_.hands[p];
  const auto& sm = g_.same[p];
  for (int i = 0; i < n; i++) {
    double m = tot;
    for (int k = 0; k < mh[i].nc; k++) m -= cardsum_[mh[i].c[k]];
    if (sm[i] >= 0) m += r[sm[i]];
    out[i] = m;
  }
}

void Solver::terminal(int ni, int p, const std::vector<double>& r, std::vector<double>& out) {
  const SNode& nd = g_.nodes[ni];
  const int q = 1 - p, n = g_.n(p);
  const double cp = nd.c[p];
  if (nd.type == S_FOLD) {
    mass(p, r, out);
    const double pay = nd.player == p ? -cp : nd.pot - cp;
    for (int i = 0; i < n; i++) out[i] *= pay;
    return;
  }
  const Board& b = g_.boards[nd.board];
  if (b.equity) {
    std::vector<double> m;
    mass(p, r, m);
    out.assign(n, 0.0);
    const int H1 = g_.n(1);
    if (p == 0) {
      for (int i = 0; i < n; i++) {
        const double* sh = &b.share[size_t(i) * H1];
        double s = 0;
        for (int j = 0; j < H1; j++) s += sh[j] * r[j];
        out[i] = nd.pot * s - cp * m[i];
      }
    } else {
      const int H0 = g_.n(0);
      std::vector<double> s(n, 0.0);
      for (int i = 0; i < H0; i++) {
        double ri = r[i];
        if (ri == 0) continue;
        const double* sh = &b.share[size_t(i) * n];
        const float* cm = &g_.compat[size_t(i) * n];
        for (int j = 0; j < n; j++) s[j] += (cm[j] - sh[j]) * ri;
      }
      for (int j = 0; j < n; j++) out[j] = nd.pot * s[j] - cp * m[j];
    }
    return;
  }
  // Strength-sorted sweep.
  const auto& mine = b.asc[p];
  const auto& opp = b.asc[q];
  const auto& smine = b.str[p];
  const auto& sopp = b.str[q];
  const auto& mh = g_.hands[p];
  const auto& oh = g_.hands[q];
  const auto& sm = g_.same[p];
  out.assign(n, 0.0);
  std::vector<double> win(n, 0.0), lose(n, 0.0);
  double cs[64];
  // total compatible mass over unblocked opponent hands
  double T = 0, CS[64];
  std::fill(CS, CS + 64, 0.0);
  for (int j : opp) {
    T += r[j];
    for (int k = 0; k < oh[j].nc; k++) CS[oh[j].c[k]] += r[j];
  }
  // ascending: opponent hands strictly weaker
  {
    std::fill(cs, cs + 64, 0.0);
    double tot = 0;
    size_t k = 0;
    for (int i : mine) {
      while (k < opp.size() && sopp[opp[k]] < smine[i]) {
        int j = opp[k++];
        tot += r[j];
        for (int c = 0; c < oh[j].nc; c++) cs[oh[j].c[c]] += r[j];
      }
      double v = tot;
      for (int c = 0; c < mh[i].nc; c++) v -= cs[mh[i].c[c]];
      win[i] = v;
    }
  }
  // descending: opponent hands strictly stronger
  {
    std::fill(cs, cs + 64, 0.0);
    double tot = 0;
    size_t k = opp.size();
    for (size_t x = mine.size(); x-- > 0;) {
      int i = mine[x];
      while (k > 0 && sopp[opp[k - 1]] > smine[i]) {
        int j = opp[--k];
        tot += r[j];
        for (int c = 0; c < oh[j].nc; c++) cs[oh[j].c[c]] += r[j];
      }
      double v = tot;
      for (int c = 0; c < mh[i].nc; c++) v -= cs[mh[i].c[c]];
      lose[i] = v;
    }
  }
  for (int i : mine) {
    double m = T;
    for (int c = 0; c < mh[i].nc; c++) m -= CS[mh[i].c[c]];
    if (sm[i] >= 0 && sopp[sm[i]] >= 0) m += r[sm[i]];
    double tie = m - win[i] - lose[i];
    out[i] = nd.pot * (win[i] + 0.5 * tie) - cp * m;
  }
}

std::vector<double> Solver::chance_child_reach(int child, int q, const std::vector<double>& r) const {
  int x = g_.nodes[child].deal;
  std::vector<double> r2 = r;
  const auto& oh = g_.hands[q];
  for (size_t j = 0; j < r2.size(); j++)
    if (oh[j].mask >> x & 1) r2[j] = 0;
  return r2;
}

void Solver::leaf_values(int ni, int p, const std::vector<std::vector<double>>& rb,
                         std::vector<std::vector<double>>& cv) const {
  const SNode& nd = g_.nodes[ni];
  const LeafValues& L = g_.leaves[nd.leaf];
  const int H0 = g_.n(0), H1 = g_.n(1);
  if (p == 0) {
    cv.assign(L.k[0], std::vector<double>(H0, 0.0));
    for (int a = 0; a < L.k[0]; a++)
      for (int b = 0; b < L.k[1]; b++) {
        const std::vector<double>& r = rb[b];
        for (int i = 0; i < H0; i++) {
          const float* V = &L.V[L.at(a, b, i, 0, H0, H1)];
          double s = 0;
          for (int j = 0; j < H1; j++) s += V[j] * r[j];
          cv[a][i] += s;
        }
      }
  } else {
    cv.assign(L.k[1], std::vector<double>(H1, 0.0));
    // pot0 * compat part, shared by every choice b
    std::vector<double> base(H1, 0.0);
    for (int a = 0; a < L.k[0]; a++)
      for (int i = 0; i < H0; i++) {
        double ri = rb[a][i];
        if (ri == 0) continue;
        const float* cm = &g_.compat[size_t(i) * H1];
        for (int j = 0; j < H1; j++) base[j] += g_.pot0 * cm[j] * ri;
      }
    for (int b = 0; b < L.k[1]; b++) {
      std::vector<double>& out = cv[b];
      out = base;
      for (int a = 0; a < L.k[0]; a++)
        for (int i = 0; i < H0; i++) {
          double ri = rb[a][i];
          if (ri == 0) continue;
          const float* V = &L.V[L.at(a, b, i, 0, H0, H1)];
          for (int j = 0; j < H1; j++) out[j] -= V[j] * ri;
        }
    }
  }
}

std::vector<double> Solver::cfr(int ni, int p, const std::vector<double>& r) {
  const SNode& nd = g_.nodes[ni];
  const int q = 1 - p, n = g_.n(p);
  std::vector<double> out;
  switch (nd.type) {
    case S_FOLD:
    case S_SHOW: terminal(ni, p, r, out); return out;
    case S_CHANCE: {
      out.assign(n, 0.0);
      const double norm = double(g_.deck - int(g_.boards[nd.board].cards.size()) - 2 * g_.cards_per_hand);
      for (int k = 0; k < nd.nact; k++) {
        int ch = nd.first + k;
        std::vector<double> v = cfr(ch, p, chance_child_reach(ch, q, r));
        int x = g_.nodes[ch].deal;
        for (int i = 0; i < n; i++)
          if (!(g_.hands[p][i].mask >> x & 1)) out[i] += v[i] / norm;
      }
      return out;
    }
    case S_LEAF: {
      const LeafValues& L = g_.leaves[nd.leaf];
      const int kq = L.k[q], kp = L.k[p], no = g_.n(q);
      // opponent's current choice strategy, reach split, average accumulation
      std::vector<double> sq(size_t(kq) * no);
      double* LRq = &LR_[leaf_off_[q][nd.leaf]];
      double* LSq = &LS_[leaf_off_[q][nd.leaf]];
      regret_match(LRq, kq, no, sq.data());
      std::vector<std::vector<double>> rb(kq, std::vector<double>(no));
      for (int b = 0; b < kq; b++)
        for (int j = 0; j < no; j++) {
          double x = sq[size_t(b) * no + j] * r[j];
          rb[b][j] = x;
          size_t s = size_t(b) * no + j;
          if (cfg_.algo == SolverConfig::DCFR) LSq[s] = LSq[s] * dstrat_ + x;
          else LSq[s] += wavg_ * x;
        }
      std::vector<std::vector<double>> cv;
      leaf_values(ni, p, rb, cv);
      std::vector<double> sp(size_t(kp) * n);
      double* LRp = &LR_[leaf_off_[p][nd.leaf]];
      regret_match(LRp, kp, n, sp.data());
      out.assign(n, 0.0);
      for (int a = 0; a < kp; a++)
        for (int i = 0; i < n; i++) out[i] += sp[size_t(a) * n + i] * cv[a][i];
      for (int a = 0; a < kp; a++)
        for (int i = 0; i < n; i++) {
          double& R = LRp[size_t(a) * n + i];
          double d = cv[a][i] - out[i];
          if (cfg_.algo == SolverConfig::DCFR) R = R * (R > 0 ? dpos_ : dneg_) + d;
          else R = std::max(0.0, R + d);
        }
      return out;
    }
    default: break;
  }
  const int na = nd.nact;
  std::vector<double> sig;
  node_current(ni, sig);
  if (nd.player == p) {
    std::vector<std::vector<double>> cv(na);
    out.assign(n, 0.0);
    for (int a = 0; a < na; a++) {
      cv[a] = cfr(nd.first + a, p, r);
      for (int i = 0; i < n; i++) out[i] += sig[size_t(a) * n + i] * cv[a][i];
    }
    double* R = &R_[nd.off];
    for (int a = 0; a < na; a++)
      for (int i = 0; i < n; i++) {
        double& x = R[size_t(a) * n + i];
        double d = cv[a][i] - out[i];
        if (cfg_.algo == SolverConfig::DCFR) x = x * (x > 0 ? dpos_ : dneg_) + d;
        else x = std::max(0.0, x + d);
      }
    return out;
  }
  const int no = g_.n(q);
  double* S = &S_[nd.off];
  out.assign(n, 0.0);
  std::vector<double> rc(no);
  for (int a = 0; a < na; a++) {
    for (int j = 0; j < no; j++) {
      double x = sig[size_t(a) * no + j] * r[j];
      rc[j] = x;
      size_t s = size_t(a) * no + j;
      if (cfg_.algo == SolverConfig::DCFR) S[s] = S[s] * dstrat_ + x;
      else S[s] += wavg_ * x;
    }
    std::vector<double> v = cfr(nd.first + a, p, rc);
    for (int i = 0; i < n; i++) out[i] += v[i];
  }
  return out;
}

void Solver::iterate() {
  const int t = iters_ + 1;
  if (cfg_.algo == SolverConfig::DCFR) {
    double ta = std::pow(double(t), cfg_.alpha), tb = std::pow(double(t), cfg_.beta);
    dpos_ = ta / (ta + 1);
    dneg_ = tb / (tb + 1);
    dstrat_ = std::pow(double(t) / double(t + 1), cfg_.gamma);
  } else {
    wavg_ = std::max(0, t - cfg_.cfrp_delay);
  }
  for (int p = 0; p < 2; p++) cfr(0, p, g_.w[1 - p]);
  iters_ = t;
}

std::vector<double> Solver::eval(int ni, int p, const std::vector<double>& r, bool br) {
  const SNode& nd = g_.nodes[ni];
  const int q = 1 - p, n = g_.n(p);
  std::vector<double> out;
  switch (nd.type) {
    case S_FOLD:
    case S_SHOW: terminal(ni, p, r, out); return out;
    case S_CHANCE: {
      out.assign(n, 0.0);
      const double norm = double(g_.deck - int(g_.boards[nd.board].cards.size()) - 2 * g_.cards_per_hand);
      for (int k = 0; k < nd.nact; k++) {
        int ch = nd.first + k;
        std::vector<double> v = eval(ch, p, chance_child_reach(ch, q, r), br);
        int x = g_.nodes[ch].deal;
        for (int i = 0; i < n; i++)
          if (!(g_.hands[p][i].mask >> x & 1)) out[i] += v[i] / norm;
      }
      return out;
    }
    case S_LEAF: {
      const LeafValues& L = g_.leaves[nd.leaf];
      const int kq = L.k[q], kp = L.k[p], no = g_.n(q);
      std::vector<std::vector<double>> rb(kq, std::vector<double>(no));
      std::vector<double> tmp(std::max(kq, kp));
      for (int j = 0; j < no; j++) {
        leaf_average(ni, q, j, tmp.data());
        for (int b = 0; b < kq; b++) rb[b][j] = tmp[b] * r[j];
      }
      std::vector<std::vector<double>> cv;
      leaf_values(ni, p, rb, cv);
      out.assign(n, br ? -1e300 : 0.0);
      for (int i = 0; i < n; i++) {
        if (br) {
          for (int a = 0; a < kp; a++) out[i] = std::max(out[i], cv[a][i]);
        } else {
          leaf_average(ni, p, i, tmp.data());
          for (int a = 0; a < kp; a++) out[i] += tmp[a] * cv[a][i];
        }
      }
      return out;
    }
    default: break;
  }
  const int na = nd.nact;
  std::vector<double> sig;
  if (nd.player == p) {
    if (!br) node_average(ni, sig);
    out.assign(n, br ? -1e300 : 0.0);
    for (int a = 0; a < na; a++) {
      std::vector<double> v = eval(nd.first + a, p, r, br);
      for (int i = 0; i < n; i++) {
        if (br) out[i] = std::max(out[i], v[i]);
        else out[i] += sig[size_t(a) * n + i] * v[i];
      }
    }
    return out;
  }
  node_average(ni, sig);
  const int no = g_.n(q);
  out.assign(n, 0.0);
  std::vector<double> rc(no);
  for (int a = 0; a < na; a++) {
    bool any = false;
    for (int j = 0; j < no; j++) {
      rc[j] = sig[size_t(a) * no + j] * r[j];
      any |= rc[j] != 0;
    }
    if (!any) continue;
    std::vector<double> v = eval(nd.first + a, p, rc, br);
    for (int i = 0; i < n; i++) out[i] += v[i];
  }
  return out;
}

double Solver::value(int p, bool br) {
  std::vector<double> cv = eval(0, p, g_.w[1 - p], br);
  double s = 0;
  for (int i = 0; i < g_.n(p); i++) s += g_.w[p][i] * cv[i];
  return s / g_.joint_mass();
}

double Solver::exploitability() { return (value(0, true) + value(1, true) - g_.pot0) / 2; }

std::vector<double> Solver::hand_values(int p, bool br) {
  std::vector<double> cv = eval(0, p, g_.w[1 - p], br), m;
  mass(p, g_.w[1 - p], m);
  for (size_t i = 0; i < cv.size(); i++) cv[i] = m[i] > 0 ? cv[i] / m[i] : 0;
  return cv;
}

// ---- TS-compatible single-street builder --------------------------------------------

namespace {

double round_chips(double x) { return std::floor(x * 100 + 0.5) / 100; }

struct TsState {
  int player;
  double c[2];
  double to_call;
  int aggr;
  bool check_closes;
  double last_inc;
};

struct TsAct {
  std::string label;
  double total;
};

std::vector<TsAct> ts_aggressive(const TsTreeParams& p, const TsState& s, double pot) {
  std::vector<TsAct> out;
  const int me = s.player, opp = 1 - me;
  const double E = p.effective_stack, call_to = s.c[opp];
  if (s.aggr >= p.max_aggressions) return out;
  if (call_to >= E || s.c[me] >= E) return out;
  const bool facing = s.to_call > 0;
  const double pac = pot + s.to_call, behind = E - call_to;
  const double min_to = facing ? call_to + std::max(s.last_inc, 1e-9) : s.c[me];
  const std::vector<double>& fr = facing ? p.raise_fracs : p.bet_fracs;
  const bool last_level = s.aggr + 1 >= p.max_aggressions && s.aggr >= 2;
  std::vector<std::pair<double, double>> totals;  // to, frac (insertion order)
  bool saw_allin = false;
  if (!last_level) {
    for (double f : fr) {
      double to = call_to + f * pac;
      if (facing && to < min_to) to = min_to;
      to = round_chips(to);
      if (to <= call_to) continue;
      double remaining = E - s.c[me];
      if (to >= E || (to - s.c[me]) >= p.allin_threshold * remaining) {
        saw_allin = true;
        continue;
      }
      bool dup = false;
      for (auto& t : totals) dup |= t.first == to;
      if (!dup) totals.push_back({to, f});
    }
  }
  double spr = behind / std::max(1e-9, pac);
  bool offer = saw_allin || last_level || spr <= p.allin_max_spr || totals.empty();
  std::sort(totals.begin(), totals.end(), [](auto& a, auto& b) { return a.first < b.first; });
  for (auto& t : totals) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%c%ld", facing ? 'R' : 'B', std::lround(t.second * 100));
    out.push_back({buf, t.first});
  }
  if (offer) out.push_back({"A", E});
  return out;
}

struct TsBuilder {
  Game& g;
  const TsTreeParams& p;
  int board;
  int leaf(uint8_t type, int player, double pot, const double c[2], int parent, const std::string& label) {
    SNode n;
    n.type = type;
    n.player = uint8_t(player);
    n.pot = pot;
    n.c[0] = c[0];
    n.c[1] = c[1];
    n.board = board;
    n.parent = parent;
    n.label = label;
    return add_node(g, n);
  }
  // Fill node `idx` (already allocated) as a decision node.
  void expand(int idx, const TsState& s) {
    const int me = s.player, opp = 1 - me;
    const double pot = p.starting_pot + s.c[0] + s.c[1];
    struct Kid {
      int kind;  // 0 fold leaf, 1 showdown leaf, 2 decision
      std::string label;
      TsState st;
      double pot;
      double c[2];
    };
    std::vector<Kid> kids;
    if (s.to_call > 0) {
      Kid f{0, "F", s, pot, {s.c[0], s.c[1]}};
      kids.push_back(f);
      double after[2] = {s.c[0], s.c[1]};
      after[me] = s.c[opp];
      Kid c{1, "C", s, p.starting_pot + after[0] + after[1], {after[0], after[1]}};
      kids.push_back(c);
    } else {
      if (s.check_closes) {
        kids.push_back(Kid{1, "X", s, pot, {s.c[0], s.c[1]}});
      } else {
        TsState t{opp, {s.c[0], s.c[1]}, 0, s.aggr, true, 0};
        kids.push_back(Kid{2, "X", t, pot, {s.c[0], s.c[1]}});
      }
    }
    for (const TsAct& a : ts_aggressive(p, s, pot)) {
      double after[2] = {s.c[0], s.c[1]};
      after[me] = a.total;
      double inc = a.total - s.c[opp];
      TsState t{opp, {after[0], after[1]}, a.total - s.c[opp], s.aggr + 1, false, std::max(inc, s.last_inc)};
      kids.push_back(Kid{2, a.label, t, p.starting_pot + after[0] + after[1], {after[0], after[1]}});
    }
    int first = int(g.nodes.size());
    for (auto& k : kids) {
      SNode n;
      n.parent = idx;
      n.label = k.label;
      n.board = board;
      n.pot = k.pot;
      n.c[0] = k.c[0];
      n.c[1] = k.c[1];
      if (k.kind == 0) n.type = S_FOLD, n.player = uint8_t(me);
      else if (k.kind == 1) n.type = S_SHOW;
      else n.type = S_DEC, n.player = uint8_t(k.st.player);
      add_node(g, n);
    }
    SNode& nd = g.nodes[idx];
    nd.type = S_DEC;
    nd.player = uint8_t(me);
    nd.first = first;
    nd.nact = int(kids.size());
    for (size_t a = 0; a < kids.size(); a++)
      if (kids[a].kind == 2) expand(first + int(a), kids[a].st);
  }
};

}  // namespace

void build_ts_tree(Game& g, const TsTreeParams& p, const std::vector<int>& board) {
  g.nodes.clear();
  g.boards.clear();
  g.pot0 = p.starting_pot;
  g.full_board = 5;
  int bi = g.add_board(board);
  const double tc = std::min(std::max(0.0, p.to_call), p.effective_stack);
  TsState s{0, {0, tc}, tc, tc > 0 ? std::max(1, p.prior_aggressions) : p.prior_aggressions, tc == 0 && p.hero_ip, tc};
  SNode root;
  root.board = bi;
  root.c[0] = 0;
  root.c[1] = tc;
  root.pot = p.starting_pot + tc;
  add_node(g, root);
  TsBuilder b{g, p, bi};
  b.expand(0, s);
}

}  // namespace rt
}  // namespace bp
