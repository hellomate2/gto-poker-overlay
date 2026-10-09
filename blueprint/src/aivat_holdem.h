// ============================================================
// aivat_holdem.h: the hold'em card model for AIVAT (aivat.h) and the
// duplicate head-to-head loop behind `bp h2h --aivat`.
//
// Chance events: both hole pairs (one event), flop, turn, river, each
// uniform over the cards left, which is how HoldemSampler deals.
//
// Value function ingredients:
//   * equity(street): flop and turn exact (all 990 turn+river runouts, all 44
//     rivers), river exact. Preflop uses a 169 x 169 class-vs-class equity
//     table estimated once by Monte Carlo with a fixed seed. The table only
//     shapes the control variate; its sampling error cannot bias the
//     estimate, because the same deterministic table is used for the
//     expectation and for the observed deal.
//   * the expectation over the two hole pairs is exact: V at the root depends
//     on the deal only through the two preflop classes, so it is a sum over
//     the 169 x 169 class pairs weighted by their exact combo counts (of the
//     1,326 x 1,225 = 1,624,350 ordered disjoint hole pairs).
//   * the expectation over the flop is an unbiased Monte Carlo average over
//     `flop_samples` flops drawn from the remaining 48 cards with a separate
//     random stream (enumerating 17,296 flops per hand is too slow). The turn
//     (45 cards) and the river (44) are enumerated exactly.
// Buckets come from the same Abstraction calls as HoldemSampler::fill, so
// the known player's strategy in the corrections is the one it played.
// Without an abstraction (abs == nullptr) every postflop bucket is 0; tests
// use that to exercise the hold'em code on a tree built with 1 bucket.
// ============================================================
#pragma once

#include <mutex>
#include <string>
#include <thread>

#include "abstraction.h"
#include "aivat.h"
#include "eval.h"
#include "games.h"

namespace bp {

struct HoldemModel {
  struct State {
    int h[2][2];
    int board[5];
    int nb;  // board cards visible
  };
  const Abstraction* abs = nullptr;
  int flop_samples = 32;
  int turn_samples = 0;  // 0 = all 45 turn cards; else an unbiased sample
  std::vector<float> pre_eq;  // [class_p * 169 + class_o]
  struct DealW {
    State st;
    double w;
  };
  std::vector<DealW> deals;  // one representative per class pair

  static int board_cards(int street) { return street == 0 ? 0 : street + 2; }

  // pre_samples: Monte Carlo samples per class pair for the preflop table.
  explicit HoldemModel(const Abstraction* a, int flop_samples_ = 32, int pre_samples = 1000, int threads = 4)
      : abs(a), flop_samples(flop_samples_) {
    build_deals();
    build_preflop_table(pre_samples, threads);
  }

  State prefix(const State& f, int street) const {
    State s = f;
    s.nb = board_cards(street);
    return s;
  }
  void buckets(const State& s, int street, int bk[2]) const {
    if (street == 0) {
      for (int i = 0; i < 2; i++) bk[i] = preflop_class(s.h[i][0], s.h[i][1]);
      return;
    }
    if (!abs) {
      bk[0] = bk[1] = 0;
      return;
    }
    if (street == 1) {
      for (int i = 0; i < 2; i++) bk[i] = abs->flop(s.h[i], s.board);
    } else if (street == 2) {
      for (int i = 0; i < 2; i++) bk[i] = abs->turn(s.h[i], s.board);
    } else if (abs->has_river_table()) {
      for (int i = 0; i < 2; i++) bk[i] = abs->river(s.h[i], s.board);
    } else {
      float e[2];
      river_ehs_pair(s.board, s.h[0], s.h[1], e);
      for (int i = 0; i < 2; i++) bk[i] = abs->river_from_ehs(e[i]);
    }
  }
  int winner(const State& s) const {
    const EvalTables& T = eval_tables();
    HandAcc a, b;
    for (int i = 0; i < 5; i++) a.add(s.board[i], T), b.add(s.board[i], T);
    a.add(s.h[0][0], T), a.add(s.h[0][1], T);
    b.add(s.h[1][0], T), b.add(s.h[1][1], T);
    int v0 = eval_acc(a, T), v1 = eval_acc(b, T);
    return v0 > v1 ? 0 : v1 > v0 ? 1 : 2;
  }
  // P(p wins) + P(tie) / 2 over the board cards still to come.
  double equity(const State& s, int street, int p) const {
    if (street == 0) {
      int c0 = preflop_class(s.h[p][0], s.h[p][1]), c1 = preflop_class(s.h[1 - p][0], s.h[1 - p][1]);
      return pre_eq[size_t(c0) * 169 + c1];
    }
    const EvalTables& T = eval_tables();
    int nb = board_cards(street);
    HandAcc A, B;
    uint64_t dead = 0;
    for (int i = 0; i < nb; i++) A.add(s.board[i], T), B.add(s.board[i], T), dead |= 1ull << s.board[i];
    for (int k = 0; k < 2; k++) {
      A.add(s.h[p][k], T), B.add(s.h[1 - p][k], T);
      dead |= 1ull << s.h[p][k] | 1ull << s.h[1 - p][k];
    }
    if (nb == 5) {
      int a = eval_acc(A, T), b = eval_acc(B, T);
      return a > b ? 1.0 : a == b ? 0.5 : 0.0;
    }
    int rem[48], nr = 0;
    for (int c = 0; c < 52; c++)
      if (!(dead >> c & 1)) rem[nr++] = c;
    long score2 = 0, n = 0;  // 2 * wins + ties
    if (nb == 4) {
      for (int i = 0; i < nr; i++) {
        HandAcc a = A, b = B;
        a.add(rem[i], T), b.add(rem[i], T);
        int va = eval_acc(a, T), vb = eval_acc(b, T);
        score2 += (va > vb) * 2 + (va == vb);
        n++;
      }
    } else {  // flop: every turn + river pair
      for (int i = 0; i < nr; i++) {
        HandAcc a1 = A, b1 = B;
        a1.add(rem[i], T), b1.add(rem[i], T);
        for (int j = i + 1; j < nr; j++) {
          HandAcc a = a1, b = b1;
          a.add(rem[j], T), b.add(rem[j], T);
          int va = eval_acc(a, T), vb = eval_acc(b, T);
          score2 += (va > vb) * 2 + (va == vb);
          n++;
        }
      }
    }
    return double(score2) / (2.0 * double(n));
  }
  template <class F>
  void for_each_deal(F f) const {
    for (const DealW& d : deals) f(d.st, d.w);
  }
  template <class F>
  void for_each_board(const State& s, int street, Rng& rng, F f) const {
    uint64_t dead = 0;
    for (int k = 0; k < 2; k++) dead |= 1ull << s.h[0][k] | 1ull << s.h[1][k];
    int nb = board_cards(street - 1);
    for (int i = 0; i < nb; i++) dead |= 1ull << s.board[i];
    State t = s;
    t.nb = board_cards(street);
    if (street == 1) {
      double w = 1.0 / flop_samples;
      for (int k = 0; k < flop_samples; k++) {
        uint64_t used = dead;
        for (int i = 0; i < 3; i++) {
          int c;
          do c = int(rng.below(52)); while (used >> c & 1);
          used |= 1ull << c;
          t.board[i] = c;
        }
        f(t, w);
      }
      return;
    }
    int rem[48], nr = 0;
    for (int c = 0; c < 52; c++)
      if (!(dead >> c & 1)) rem[nr++] = c;
    if (street == 2 && turn_samples > 0) {
      double w = 1.0 / turn_samples;
      for (int k = 0; k < turn_samples; k++) {
        t.board[nb] = rem[rng.below(uint32_t(nr))];
        f(t, w);
      }
      return;
    }
    double w = 1.0 / nr;
    for (int i = 0; i < nr; i++) {
      t.board[nb] = rem[i];
      f(t, w);
    }
  }

  static State from_deal(const Deal& d) {
    State s;
    for (int i = 0; i < 2; i++)
      for (int k = 0; k < 2; k++) s.h[i][k] = d.hole[i][k];
    for (int i = 0; i < 5; i++) s.board[i] = d.board[i];
    s.nb = 5;
    return s;
  }

 private:
  void build_deals() {
    const ComboTable& C = combos();
    std::vector<std::vector<int>> by_class(169);
    for (int i = 0; i < NUM_COMBOS; i++) by_class[preflop_class(C.hi[i], C.lo[i])].push_back(i);
    std::vector<double> cnt(169 * 169, 0.0);
    for (int i = 0; i < NUM_COMBOS; i++) {
      int ci = preflop_class(C.hi[i], C.lo[i]);
      uint64_t mi = 1ull << C.hi[i] | 1ull << C.lo[i];
      for (int j = 0; j < NUM_COMBOS; j++) {
        uint64_t mj = 1ull << C.hi[j] | 1ull << C.lo[j];
        if (mi & mj) continue;
        cnt[size_t(ci) * 169 + preflop_class(C.hi[j], C.lo[j])] += 1;
      }
    }
    const double total = double(NUM_COMBOS) * 1225.0;
    for (int a = 0; a < 169; a++)
      for (int b = 0; b < 169; b++) {
        double c = cnt[size_t(a) * 169 + b];
        if (c == 0) continue;
        int ia = by_class[a][0];
        int ib = -1;
        for (int j : by_class[b])
          if (!((1ull << C.hi[j] | 1ull << C.lo[j]) & (1ull << C.hi[ia] | 1ull << C.lo[ia]))) {
            ib = j;
            break;
          }
        if (ib < 0) die("aivat: no disjoint representative for a class pair");
        DealW d{};
        d.st.h[0][0] = C.hi[ia], d.st.h[0][1] = C.lo[ia];
        d.st.h[1][0] = C.hi[ib], d.st.h[1][1] = C.lo[ib];
        d.st.nb = 0;
        d.w = c / total;
        deals.push_back(d);
      }
  }
  void build_preflop_table(int S, int threads) {
    pre_eq.assign(169 * 169, 0.5f);
    const ComboTable& C = combos();
    std::vector<std::vector<int>> by_class(169);
    for (int i = 0; i < NUM_COMBOS; i++) by_class[preflop_class(C.hi[i], C.lo[i])].push_back(i);
    const EvalTables& T = eval_tables();
    auto rows = [&](int lo, int hi) {
      for (int a = lo; a < hi; a++) {
        Rng rng(0x5EED0000ULL + uint64_t(a));
        for (int b = a + 1; b < 169; b++) {
          long score2 = 0;
          for (int k = 0; k < S; k++) {
            int ia, ib;
            uint64_t ma, mb;
            do {
              ia = by_class[a][rng.below(uint32_t(by_class[a].size()))];
              ib = by_class[b][rng.below(uint32_t(by_class[b].size()))];
              ma = 1ull << C.hi[ia] | 1ull << C.lo[ia];
              mb = 1ull << C.hi[ib] | 1ull << C.lo[ib];
            } while (ma & mb);
            uint64_t used = ma | mb;
            HandAcc A, B;
            A.add(C.hi[ia], T), A.add(C.lo[ia], T);
            B.add(C.hi[ib], T), B.add(C.lo[ib], T);
            for (int i = 0; i < 5; i++) {
              int c;
              do c = int(rng.below(52)); while (used >> c & 1);
              used |= 1ull << c;
              A.add(c, T), B.add(c, T);
            }
            int va = eval_acc(A, T), vb = eval_acc(B, T);
            score2 += (va > vb) * 2 + (va == vb);
          }
          float e = float(double(score2) / (2.0 * S));
          pre_eq[size_t(a) * 169 + b] = e;
          pre_eq[size_t(b) * 169 + a] = 1.0f - e;
        }
      }
    };
    if (S <= 0) return;
    int Tn = std::max(1, threads);
    std::vector<std::thread> pool;
    // rows near the top have more pairs; interleave by blocks
    for (int t = 0; t < Tn; t++)
      pool.emplace_back([&, t] {
        for (int a = t; a < 169; a += Tn) rows(a, a + 1);
      });
    for (auto& th : pool) th.join();
  }
};

// ---- duplicate head-to-head with AIVAT ----------------------------------------------
struct AivatH2HStats {
  RunStat game_plain, game_aivat;   // one sample per hand (A's result)
  RunStat dup_plain, dup_aivat;     // one sample per deal (seat-averaged)
  RunStat dup_diff;                 // dup_aivat - dup_plain, per deal
  RunStat chance, action;           // per hand correction terms
  void merge(const AivatH2HStats& o) {
    game_plain.merge(o.game_plain), game_aivat.merge(o.game_aivat);
    dup_plain.merge(o.dup_plain), dup_aivat.merge(o.dup_aivat), dup_diff.merge(o.dup_diff);
    chance.merge(o.chance), action.merge(o.action);
  }
};

// play_pol: the strategies the agents actually use (A, B). score_pol: what
// the estimator assumes for A and B (equal to play_pol for a known agent, a
// model such as A's blueprint for an unknown one). known: whose actions get
// corrections. Every deal is played twice with seats swapped, as in
// play_h2h; results are A's, in chips.
// Seed of the chance-expectation stream for game `id`. It depends only on
// the game counter, never on the cards, so the sampled flops are independent
// of the dealt ones; `bp aivat-log` uses the same function, so a replayed
// log reproduces every estimate exactly.
inline uint64_t aivat_chance_seed(uint64_t seed, uint64_t id) {
  uint64_t x = seed * 0x9E3779B97F4A7C15ULL + id;
  return splitmix64(x);
}

// One line of an AIVAT hand log (see `bp aivat-log` in main.cpp):
//   id seatA holeA holeB board tokens resultA
// seatA = A's position (0 = small blind / button), cards like AhKd, the
// board as five cards, tokens = the comma-separated tree history from the
// root to the terminal node, resultA = A's chips won.
inline std::string aivat_log_line(const BettingTree& tree, uint64_t id, int seatA, const Deal& d,
                                  const std::vector<uint32_t>& path, double resultA) {
  std::string s = std::to_string(id) + " " + std::to_string(seatA) + " ";
  for (int k = 0; k < 2; k++) s += card_str(d.hole[seatA][k]);
  s += " ";
  for (int k = 0; k < 2; k++) s += card_str(d.hole[1 - seatA][k]);
  s += " ";
  for (int k = 0; k < 5; k++) s += card_str(d.board[k]);
  s += " ";
  for (size_t k = 1; k < path.size(); k++) s += (k > 1 ? "," : "") + tree.token(path[k]);
  char buf[64];
  std::snprintf(buf, sizeof buf, " %.17g\n", resultA);
  return s + buf;
}

inline AivatH2HStats aivat_h2h(const BettingTree& tree, const HoldemSampler& smp, const HoldemModel& M,
                               const PolicyFn play_pol[2], const PolicyFn score_pol[2], const bool known[2],
                               int64_t deals, int threads, uint64_t seed, FILE* log = nullptr,
                               int lookahead_from = -1, bool lookahead_full = false) {
  std::mutex log_mu;
  // scorer[k]: A sits in position k.
  Aivat<HoldemModel> s0(tree, M, score_pol[0], score_pol[1], known[0], known[1], false, lookahead_from,
                        !lookahead_full);
  Aivat<HoldemModel> s1(tree, M, score_pol[1], score_pol[0], known[1], known[0], false, lookahead_from,
                        !lookahead_full);
  const Aivat<HoldemModel>* sc[2] = {&s0, &s1};
  std::vector<AivatH2HStats> st(threads);
  std::vector<std::thread> pool;
  for (int t = 0; t < threads; t++)
    pool.emplace_back([&, t] {
      Rng rng(seed * 1000 + uint64_t(t));
      Rng crng(1);  // chance expectations only, reseeded per game
      auto scr = s0.scratch();
      std::string buf;
      Deal d;
      std::vector<uint32_t> path;
      int64_t n = deals / threads + (t < deals % threads ? 1 : 0);
      for (int64_t i = 0; i < n; i++) {
        smp.sample(rng, d);
        HoldemModel::State full = HoldemModel::from_deal(d);
        double dp = 0, da = 0;
        for (int seat = 0; seat < 2; seat++) {
          path.clear();
          uint32_t ni = 0;
          path.push_back(0);
          while (tree.nodes[ni].type == DECISION) {
            const Node& nd = tree.nodes[ni];
            const PolicyFn& who = nd.player == seat ? play_pol[0] : play_pol[1];
            double pr[MAX_ACTIONS];
            who(ni, d.bucket[nd.player][nd.street], pr);
            ni = nd.child + sample_action(pr, nd.nact, rng.uniform());
            path.push_back(ni);
          }
          // the buckets the estimator recomputes must be the ones played
          for (size_t k = 0; k + 1 < path.size(); k++) {
            const Node& nd = tree.nodes[path[k]];
            int bk[2];
            M.buckets(M.prefix(full, nd.street), nd.street, bk);
            if (bk[0] != d.bucket[0][nd.street] || bk[1] != d.bucket[1][nd.street])
              die("aivat: model buckets differ from the sampler's");
          }
          uint64_t id = 2 * uint64_t(t + i * threads) + uint64_t(seat);
          crng.reseed(aivat_chance_seed(seed, id));
          auto r = sc[seat]->score(full, path, seat, crng, scr);
          if (log) buf += aivat_log_line(tree, id, seat, d, path, r.plain);
          st[t].game_plain.add(r.plain);
          st[t].game_aivat.add(r.total());
          st[t].chance.add(r.chance);
          st[t].action.add(r.action);
          dp += 0.5 * r.plain;
          da += 0.5 * r.total();
        }
        st[t].dup_plain.add(dp);
        st[t].dup_aivat.add(da);
        st[t].dup_diff.add(da - dp);
        if (log && buf.size() > (1u << 16)) {
          std::lock_guard<std::mutex> g(log_mu);
          std::fputs(buf.c_str(), log);
          buf.clear();
        }
      }
      if (log && !buf.empty()) {
        std::lock_guard<std::mutex> g(log_mu);
        std::fputs(buf.c_str(), log);
      }
    });
  for (auto& th : pool) th.join();
  AivatH2HStats out;
  for (auto& s : st) out.merge(s);
  return out;
}

}  // namespace bp
