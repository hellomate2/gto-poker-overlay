// ============================================================
// lbr.h: Local Best Response (Lisy and Bowling, "Equilibrium Approximation
// Quality of Current No-Limit Poker Bots", 2017, https://arxiv.org/abs/1612.07547).
//
// LBR plays real hands against a fixed target strategy (here a blueprint
// policy over the abstract betting tree, or a simple bot). It sees its own
// real cards and the real board, never the target's buckets, and keeps the
// exact Bayesian posterior ("range") over the target's private hand: start
// uniform over hands consistent with LBR's cards, zero hands that collide
// with each new board card, and after every target action multiply each
// hand's weight by the target's probability of that action holding it.
//
// At each of its own decisions LBR scores a fixed action menu with a one-step
// lookahead and plays the best one:
//   fold         -my_commitment (chips already in are lost)
//   check/call   (2 eq - 1) * C, where C is the matched commitment after the
//                call and eq is LBR's showdown equity (win + tie / 2) against
//                the range, assuming the hand is checked down from here
//   bet/raise    fold_prob * their_commitment
//                + (1 - fold_prob) * (2 eq' - 1) * my_new_commitment,
//                where fold_prob is the range-weighted probability that the
//                target folds immediately and eq' is the equity against the
//                range reweighted by (1 - P(fold | hand)); a non-fold is
//                treated as a call.
// These are the paper's formulas shifted by the constant -my_commitment,
// which does not change the argmax. Equity is exact on the flop, turn and
// river (every remaining runout is enumerated, card removal exact per target
// hand) and Monte Carlo over sampled boards preflop (HoldemLbrGame::pre_samples).
//
// Action menus (LbrConfig::actions), restricted to actions present in the
// target's betting tree so the target's response can be read off its policy
// without action translation:
//   fc    fold, check/call
//   fcpa  fold, check/call, the pot-sized bet or raise (frac 1.0, if the tree
//         has it at this node), all-in
//   tree  every action the tree offers at the node
// Limit games (Kuhn, Leduc) have one bet size, so fcpa and tree both mean
// fold / check-call / bet-raise there. On streets before active_from, LBR
// just checks or calls (the paper's "rounds 3-4" setting is active_from = 2).
//
// Because LBR is a legal strategy of the full game, its expected winnings
// against the target lower-bound the target's full-game exploitability (in
// expectation; a sample mean carries its confidence interval). Unlike
// `bp br`, LBR is not limited to the target's card abstraction.
//
// Variance reduction ("imaginary observations" at showdown): the posterior
// over the target's hand given LBR's cards, the full board and the public
// action sequence is exactly LBR's range (the deal is uniform over hands
// disjoint from the known cards, and the action probabilities depend on the
// hand only through the policy). So replacing the realized showdown outcome
// by its range-weighted expectation gives an unbiased estimate of the same
// mean with lower variance. Play reports both estimators.
//
// The game-specific parts (hands, buckets, equity) live in small adapters:
// KuhnLbrGame and LeducLbrGame (validated against ExactEval) and
// HoldemLbrGame. Lbr<G>::exact() computes LBR's exact expected value on one
// deal by branching over every target action (small games only).
// ============================================================
#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>
#include <string>
#include <thread>
#include <vector>

#include "abstraction.h"
#include "eval.h"
#include "games.h"
#include "tree.h"

namespace bp {

enum LbrActions { LBR_FC = 0, LBR_FCPA = 1, LBR_TREE = 2 };

inline int parse_lbr_actions(const std::string& s) {
  if (s == "fc") return LBR_FC;
  if (s == "fcpa") return LBR_FCPA;
  if (s == "tree") return LBR_TREE;
  die("unknown LBR action set " + s + " (fc, fcpa, tree)");
}
inline const char* lbr_actions_name(int a) { return a == LBR_FC ? "fc" : a == LBR_FCPA ? "fcpa" : "tree"; }

struct LbrConfig {
  int actions = LBR_FCPA;
  int active_from = 0;  // first street (0-based) on which LBR computes; before it, check/call
};

// Fixed simple policies over a betting tree, as per-slot probabilities
// (independent of the bucket): "fold" folds whenever facing a bet and checks
// otherwise, "checkcall" always checks or calls, "maniac" always takes the
// largest bet / raise / all-in (else calls), "random" is uniform.
inline bool fixed_policy(const BettingTree& tree, const std::string& name, std::vector<float>& pol) {
  if (name != "fold" && name != "checkcall" && name != "maniac" && name != "random") return false;
  pol.assign(tree.num_slots, 0.f);
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    int pick = -1, passive = -1;
    for (int a = 0; a < n.nact; a++) {
      int k = tree.nodes[n.child + a].act_kind;
      if (k == ACT_CHECK || k == ACT_CALL) passive = a;
      if (k == ACT_FOLD) pick = a;
    }
    if (name == "checkcall" || pick < 0) pick = passive;
    if (name == "maniac") pick = n.nact - 1;
    for (int b = 0; b < tree.buckets[n.street]; b++)
      for (int a = 0; a < n.nact; a++)
        pol[n.slot + uint64_t(b) * n.nact + a] = name == "random" ? 1.f / n.nact : (a == pick ? 1.f : 0.f);
  }
  return true;
}

// ---- game adapters ----------------------------------------------------------------
//
// A Deal carries the real cards in hole[p][*] and board[*] and the showdown
// winner. Each adapter provides:
//   num_hands()                      size of the target's private-hand space
//   hand_of(d, p)                    index of player p's real private hand
//   reset(d, me, range)              uniform over hands consistent with LBR's cards
//   reveal(d, me, street, range)     zero hands colliding with cards public at `street`
//   buckets(d, street, ob)           target's bucket for every hand (-1 = impossible)
//   equity(d, me, street, rng, eq)   LBR's win + tie/2 vs each hand, over unseen cards
//   showdown_equity(d, me, eq)       same on the complete board

struct KuhnLbrGame {
  static Deal deal(int a, int b) {
    Deal d{};
    KuhnSampler::fill(a, b, d);
    d.hole[0][0] = int8_t(a);
    d.hole[1][0] = int8_t(b);
    return d;
  }
  int num_hands() const { return 3; }
  int hand_of(const Deal& d, int p) const { return d.hole[p][0]; }
  void reset(const Deal& d, int me, double* r) const {
    for (int h = 0; h < 3; h++) r[h] = h == d.hole[me][0] ? 0.0 : 1.0;
  }
  void reveal(const Deal&, int, int, double*) const {}
  void buckets(const Deal&, int, int* ob) const {
    for (int h = 0; h < 3; h++) ob[h] = h;
  }
  void equity(const Deal& d, int me, int, Rng&, double* eq) const {
    for (int h = 0; h < 3; h++) eq[h] = d.hole[me][0] > h ? 1.0 : 0.0;
  }
  void showdown_equity(const Deal& d, int me, double* eq) const {
    Rng r(1);
    equity(d, me, 0, r, eq);
  }
};

struct LeducLbrGame {
  // cards 0..5, rank = card / 2
  static Deal deal(int c0, int c1, int pub) {
    Deal d{};
    LeducSampler::fill(c0, c1, pub, d);
    d.hole[0][0] = int8_t(c0);
    d.hole[1][0] = int8_t(c1);
    d.board[0] = int8_t(pub);
    return d;
  }
  // 1 if card a beats b with public card p, 0.5 tie, 0 loss (LeducSampler's rules)
  static double score(int a, int b, int p) {
    int ra = a / 2, rb = b / 2, rp = p / 2;
    if (ra == rp) return 1.0;
    if (rb == rp) return 0.0;
    if (ra == rb) return 0.5;
    return ra > rb ? 1.0 : 0.0;
  }
  int num_hands() const { return 6; }
  int hand_of(const Deal& d, int p) const { return d.hole[p][0]; }
  void reset(const Deal& d, int me, double* r) const {
    for (int h = 0; h < 6; h++) r[h] = h == d.hole[me][0] ? 0.0 : 1.0;
  }
  void reveal(const Deal& d, int, int street, double* r) const {
    if (street >= 1) r[int(d.board[0])] = 0.0;
  }
  void buckets(const Deal& d, int street, int* ob) const {
    for (int h = 0; h < 6; h++) ob[h] = street == 0 ? h / 2 : (h / 2) * 3 + d.board[0] / 2;
  }
  void equity(const Deal& d, int me, int street, Rng&, double* eq) const {
    int m = d.hole[me][0];
    for (int h = 0; h < 6; h++) {
      eq[h] = 0;
      if (h == m) continue;
      if (street >= 1) {
        eq[h] = score(m, h, d.board[0]);
        continue;
      }
      int cnt = 0;
      for (int p = 0; p < 6; p++)
        if (p != m && p != h) eq[h] += score(m, h, p), cnt++;
      eq[h] /= cnt;
    }
  }
  void showdown_equity(const Deal& d, int me, double* eq) const {
    Rng r(1);
    equity(d, me, 1, r, eq);
  }
};

// Hold'em: hands are the 1,326 two-card combos (common.h combo_index).
// buckets() uses the same Abstraction lookups as HoldemSampler::fill, so the
// range model and the target's real play agree. Preflop buckets are always
// the 169 classes; with abs == nullptr every postflop bucket is 0 (for tests
// and bot targets on a tree with one postflop bucket per street).
struct HoldemLbrGame {
  const Abstraction* abs = nullptr;

  static int board_cards(int street) { return street == 0 ? 0 : street + 2; }
  int num_hands() const { return NUM_COMBOS; }
  int hand_of(const Deal& d, int p) const { return combo_index(d.hole[p][0], d.hole[p][1]); }
  void reset(const Deal& d, int me, double* r) const {
    const ComboTable& C = combos();
    uint64_t dead = (1ull << d.hole[me][0]) | (1ull << d.hole[me][1]);
    for (int h = 0; h < NUM_COMBOS; h++) r[h] = ((dead >> C.hi[h]) & 1) || ((dead >> C.lo[h]) & 1) ? 0.0 : 1.0;
  }
  void reveal(const Deal& d, int, int street, double* r) const {
    const ComboTable& C = combos();
    uint64_t dead = 0;
    for (int i = 0; i < board_cards(street); i++) dead |= 1ull << d.board[i];
    if (!dead) return;
    for (int h = 0; h < NUM_COMBOS; h++)
      if (((dead >> C.hi[h]) & 1) || ((dead >> C.lo[h]) & 1)) r[h] = 0.0;
  }
  void buckets(const Deal& d, int street, int* ob) const {
    const ComboTable& C = combos();
    int k = board_cards(street);
    uint64_t dead = 0;
    int board[5];
    for (int i = 0; i < k; i++) board[i] = d.board[i], dead |= 1ull << d.board[i];
    std::vector<float> ehs;
    if (street == 3 && abs && !abs->has_river_table()) {
      ehs.resize(NUM_COMBOS);
      river_ehs_all(board, ehs.data());
    }
    for (int h = 0; h < NUM_COMBOS; h++) {
      int hole[2] = {C.hi[h], C.lo[h]};
      if (((dead >> hole[0]) & 1) || ((dead >> hole[1]) & 1)) {
        ob[h] = -1;
        continue;
      }
      if (street == 0) {
        ob[h] = preflop_class(hole[0], hole[1]);
        continue;
      }
      if (!abs) {
        ob[h] = 0;
        continue;
      }
      switch (street) {
        case 1: ob[h] = abs->flop(hole, board); break;
        case 2: ob[h] = abs->turn(hole, board); break;
        default: ob[h] = abs->has_river_table() ? abs->river(hole, board) : abs->river_from_ehs(ehs[h]); break;
      }
    }
  }

  // eq[h] for every combo h disjoint from LBR's hole and the visible board
  // (others are left at 0). Exact enumeration on the flop (1,081 runouts),
  // turn (46) and river; preflop averages over pre_samples random boards,
  // each target combo using the sampled boards that do not collide with it.
  void equity_k(const Deal& d, int me, int k, Rng& rng, int pre_samples, double* eq) const {
    const EvalTables& T = eval_tables();
    const ComboTable& C = combos();
    int mh0 = d.hole[me][0], mh1 = d.hole[me][1];
    uint64_t dead = (1ull << mh0) | (1ull << mh1);
    HandAcc base;
    for (int i = 0; i < k; i++) base.add(d.board[i], T), dead |= 1ull << d.board[i];
    int deck[52], nd = 0;
    for (int c = 0; c < 52; c++)
      if (!((dead >> c) & 1)) deck[nd++] = c;
    // live combos
    std::vector<int> hs;
    hs.reserve(NUM_COMBOS);
    for (int h = 0; h < NUM_COMBOS; h++) {
      eq[h] = 0;
      if (!((dead >> C.hi[h]) & 1) && !((dead >> C.lo[h]) & 1)) hs.push_back(h);
    }
    std::vector<double> win(NUM_COMBOS, 0.0);
    std::vector<int> cnt(NUM_COMBOS, 0);
    auto runout = [&](const HandAcc& b5, uint64_t used) {
      HandAcc m = b5;
      m.add(mh0, T);
      m.add(mh1, T);
      int mv = eval_acc(m, T);
      for (int h : hs) {
        int a = C.hi[h], b = C.lo[h];
        if (((used >> a) & 1) || ((used >> b) & 1)) continue;
        HandAcc o = b5;
        o.add(a, T);
        o.add(b, T);
        int ov = eval_acc(o, T);
        win[h] += mv > ov ? 1.0 : mv == ov ? 0.5 : 0.0;
        cnt[h]++;
      }
    };
    if (k == 5) {
      runout(base, 0);
    } else if (k == 4) {
      for (int i = 0; i < nd; i++) {
        HandAcc b = base;
        b.add(deck[i], T);
        runout(b, 1ull << deck[i]);
      }
    } else if (k == 3) {
      for (int i = 0; i < nd; i++)
        for (int j = i + 1; j < nd; j++) {
          HandAcc b = base;
          b.add(deck[i], T);
          b.add(deck[j], T);
          runout(b, (1ull << deck[i]) | (1ull << deck[j]));
        }
    } else {
      for (int s = 0; s < pre_samples; s++) {
        uint64_t used = 0;
        HandAcc b;
        for (int i = 0; i < 5; i++) {
          int c;
          do c = deck[rng.below(uint32_t(nd))]; while ((used >> c) & 1);
          used |= 1ull << c;
          b.add(c, T);
        }
        runout(b, used);
      }
    }
    for (int h : hs) eq[h] = cnt[h] ? win[h] / cnt[h] : 0.5;
  }
  int pre_samples = 1000;
  void equity(const Deal& d, int me, int street, Rng& rng, double* eq) const {
    equity_k(d, me, board_cards(street), rng, pre_samples, eq);
  }
  void showdown_equity(const Deal& d, int me, double* eq) const {
    Rng r(1);
    equity_k(d, me, 5, r, 0, eq);
  }
};

// Sample a hold'em deal with real cards and the showdown winner (buckets are
// not filled: LBR computes the target's buckets for every combo itself).
inline void holdem_lbr_deal(Rng& rng, Deal& d) {
  uint64_t used = 0;
  int c[9];
  for (int i = 0; i < 9; i++) {
    int x;
    do x = int(rng.below(52)); while ((used >> x) & 1);
    used |= 1ull << x;
    c[i] = x;
  }
  d = Deal{};
  for (int i = 0; i < 2; i++) d.hole[0][i] = int8_t(c[i]), d.hole[1][i] = int8_t(c[2 + i]);
  for (int i = 0; i < 5; i++) d.board[i] = int8_t(c[4 + i]);
  int s0[7] = {c[0], c[1], c[4], c[5], c[6], c[7], c[8]};
  int s1[7] = {c[2], c[3], c[4], c[5], c[6], c[7], c[8]};
  int v0 = eval_n(s0, 7), v1 = eval_n(s1, 7);
  d.winner = uint8_t(v0 > v1 ? 0 : v1 > v0 ? 1 : 2);
}

// ---- the LBR agent ---------------------------------------------------------------------

struct LbrStats {
  uint64_t decisions = 0, folds = 0, calls = 0, bets = 0, allins = 0;
  void add(const LbrStats& o) {
    decisions += o.decisions, folds += o.folds, calls += o.calls, bets += o.bets, allins += o.allins;
  }
};

template <class G>
class Lbr {
 public:
  const BettingTree& tree;
  const std::vector<float>& pol;  // target policy, normalized per (node, bucket)
  const G& game;
  LbrConfig cfg;

  Lbr(const BettingTree& t, const std::vector<float>& p, const G& g, const LbrConfig& c)
      : tree(t), pol(p), game(g), cfg(c) {}

  struct Result {
    double chips;  // LBR's realized payoff
    double io;     // imaginary-observation estimate (range-weighted showdowns)
  };

  // Per-deal cache of the target's buckets and LBR's equity, per street.
  struct Ctx {
    const Deal* d = nullptr;
    int me = 0;
    Rng* rng = nullptr;
    bool ob_ok[4] = {false, false, false, false}, eq_ok[4] = {false, false, false, false};
    std::vector<int> ob[4];
    std::vector<double> eq[4];
    LbrStats stats;
  };

  void begin(Ctx& c, const Deal& d, int me, Rng& rng) const {
    c.d = &d;
    c.me = me;
    c.rng = &rng;
    for (int s = 0; s < 4; s++) c.ob_ok[s] = c.eq_ok[s] = false;
  }
  const std::vector<int>& obk(Ctx& c, int street) const {
    if (!c.ob_ok[street]) {
      c.ob[street].resize(game.num_hands());
      game.buckets(*c.d, street, c.ob[street].data());
      c.ob_ok[street] = true;
    }
    return c.ob[street];
  }
  const std::vector<double>& eqk(Ctx& c, int street) const {
    if (!c.eq_ok[street]) {
      c.eq[street].resize(game.num_hands());
      game.equity(*c.d, c.me, street, *c.rng, c.eq[street].data());
      c.eq_ok[street] = true;
    }
    return c.eq[street];
  }

  bool in_menu(const Node& c) const {
    switch (c.act_kind) {
      case ACT_FOLD:
      case ACT_CHECK:
      case ACT_CALL: return true;
      case ACT_ALLIN: return cfg.actions != LBR_FC;
      case ACT_BET:
      case ACT_RAISE:
        if (cfg.actions == LBR_FC) return false;
        if (cfg.actions == LBR_TREE) return true;
        // fcpa: the pot-sized bet / raise; limit games have a single size
        return c.frac_milli == 1000 || tree.cfg.street[tree.nodes[c.parent].street].limit;
      default: return false;
    }
  }

  // Values of every child of LBR's decision node ni (NaN = not in the menu).
  // Exposed for tests.
  void action_values(Ctx& c, uint32_t ni, const std::vector<double>& range, double* val) const {
    const Node& n = tree.nodes[ni];
    const int me = c.me, op = 1 - me;
    const std::vector<double>& eq = eqk(c, n.street);
    const int H = game.num_hands();
    double R = 0, E = 0;  // sum of range, sum of range * (2 eq - 1)
    for (int h = 0; h < H; h++)
      if (range[h] > 0) R += range[h], E += range[h] * (2 * eq[h] - 1);
    for (int a = 0; a < n.nact; a++) {
      const Node& ch = tree.nodes[n.child + a];
      val[a] = std::nan("");
      if (!in_menu(ch)) continue;
      if (R <= 0) {
        val[a] = ch.act_kind == ACT_CHECK || ch.act_kind == ACT_CALL ? 0.0 : -1e300;
        continue;
      }
      if (ch.act_kind == ACT_FOLD) {
        val[a] = -double(n.contrib[me]);
      } else if (ch.act_kind == ACT_CHECK || ch.act_kind == ACT_CALL) {
        // matched commitment after the call (contributions are equal)
        val[a] = E / R * double(ch.contrib[me]);
      } else {
        // the target responds at ch; read its fold probability per hand
        if (ch.type != DECISION) die("LBR: bet leads to a terminal node");
        int fa = -1;
        for (int x = 0; x < ch.nact; x++)
          if (tree.nodes[ch.child + x].act_kind == ACT_FOLD) fa = x;
        const std::vector<int>& ob = obk(c, ch.street);
        double v = 0;
        const double win_fold = double(ch.contrib[op]), cm = double(ch.contrib[me]);
        for (int h = 0; h < H; h++) {
          if (range[h] <= 0) continue;
          double f = fa < 0 ? 0.0 : double(pol[ch.slot + uint64_t(ob[h]) * ch.nact + fa]);
          v += range[h] * (f * win_fold + (1 - f) * (2 * eq[h] - 1) * cm);
        }
        val[a] = v / R;
      }
    }
  }

  int choose(Ctx& c, uint32_t ni, const std::vector<double>& range) const {
    const Node& n = tree.nodes[ni];
    int pick = -1;
    if (n.street < cfg.active_from) {
      for (int a = 0; a < n.nact; a++) {
        int k = tree.nodes[n.child + a].act_kind;
        if (k == ACT_CHECK || k == ACT_CALL) pick = a;
      }
    } else {
      double val[MAX_ACTIONS];
      action_values(c, ni, range, val);
      double best = -1e301;
      for (int a = 0; a < n.nact; a++)
        if (!std::isnan(val[a]) && val[a] > best) best = val[a], pick = a;
    }
    if (pick < 0) die("LBR: no action available");
    c.stats.decisions++;
    int k = tree.nodes[n.child + pick].act_kind;
    if (k == ACT_FOLD) c.stats.folds++;
    else if (k == ACT_CHECK || k == ACT_CALL) c.stats.calls++;
    else if (k == ACT_ALLIN) c.stats.allins++;
    else c.stats.bets++;
    return pick;
  }

  static void normalize(std::vector<double>& r) {
    double s = 0;
    for (double x : r) s += x;
    if (s > 0)
      for (double& x : r) x /= s;
  }

  // Range-weighted showdown value of a SHOWDOWN node (contributions equal).
  double io_showdown(Ctx& c, const Node& t, std::vector<double>& range) const {
    game.reveal(*c.d, c.me, tree.cfg.nstreets - 1, range.data());
    std::vector<double> eq(game.num_hands());
    game.showdown_equity(*c.d, c.me, eq.data());
    double R = 0, E = 0;
    for (int h = 0; h < game.num_hands(); h++)
      if (range[h] > 0) R += range[h], E += range[h] * (2 * eq[h] - 1);
    return R > 0 ? E / R * double(t.contrib[c.me]) : 0.0;
  }

  // Play one hand with LBR in seat `me`; the target samples its actions from
  // its policy with its real hand.
  Result play(Ctx& c, const Deal& d, int me, Rng& rng) const {
    begin(c, d, me, rng);
    std::vector<double> range(game.num_hands());
    game.reset(d, me, range.data());
    const int op = 1 - me;
    const int oh = game.hand_of(d, op);
    int street = -1;
    uint32_t ni = 0;
    while (true) {
      const Node& n = tree.nodes[ni];
      if (n.type != DECISION) {
        double chips = terminal_utility(n, me, d.winner);
        double io = n.type == SHOWDOWN ? io_showdown(c, n, range) : chips;
        return {chips, io};
      }
      if (n.street != street) {
        street = n.street;
        game.reveal(d, me, street, range.data());
        normalize(range);
      }
      if (n.player == me) {
        ni = n.child + choose(c, ni, range);
      } else {
        const std::vector<int>& ob = obk(c, street);
        const float* p = &pol[n.slot + uint64_t(ob[oh]) * n.nact];
        double r = rng.uniform(), acc = 0;
        int pick = n.nact - 1;
        for (int a = 0; a < n.nact; a++) {
          acc += p[a];
          if (r < acc) {
            pick = a;
            break;
          }
        }
        for (int h = 0; h < game.num_hands(); h++)
          if (range[h] > 0) range[h] *= double(pol[n.slot + uint64_t(ob[h]) * n.nact + pick]);
        normalize(range);
        ni = n.child + pick;
      }
    }
  }

  // Exact expected payoff to LBR on one deal, branching over every target
  // action (exponential in the tree depth; small games only).
  double exact(const Deal& d, int me, Rng& rng) const {
    Ctx c;
    begin(c, d, me, rng);
    std::vector<double> range(game.num_hands());
    game.reset(d, me, range.data());
    return exact_rec(c, 0, -1, range);
  }

 private:
  double exact_rec(Ctx& c, uint32_t ni, int street, std::vector<double> range) const {
    const Node& n = tree.nodes[ni];
    const Deal& d = *c.d;
    if (n.type != DECISION) return terminal_utility(n, c.me, d.winner);
    if (n.street != street) {
      street = n.street;
      game.reveal(d, c.me, street, range.data());
      normalize(range);
    }
    if (n.player == c.me) return exact_rec(c, n.child + choose(c, ni, range), street, range);
    const std::vector<int>& ob = obk(c, street);
    const int oh = game.hand_of(d, 1 - c.me);
    double v = 0;
    for (int a = 0; a < n.nact; a++) {
      double p = pol[n.slot + uint64_t(ob[oh]) * n.nact + a];
      if (p <= 0) continue;
      std::vector<double> r2 = range;
      for (int h = 0; h < game.num_hands(); h++)
        if (r2[h] > 0) r2[h] *= double(pol[n.slot + uint64_t(ob[h]) * n.nact + a]);
      normalize(r2);
      v += p * exact_rec(c, n.child + a, street, r2);
    }
    return v;
  }
};

// ---- hold'em match driver -------------------------------------------------------------

struct LbrMatch {
  int64_t deals = 0;          // duplicate deals completed (each = 2 hands)
  double mean_chips = 0, ci_chips = 0;  // per hand, seat-averaged, 95% half-width
  double mean_io = 0, ci_io = 0;
  double seat_mean[2] = {0, 0};          // chips per hand with LBR in seat 0 (SB) / 1 (BB)
  double seconds = 0;
  LbrStats stats;
};

// Duplicate match: every deal is played twice, LBR in each seat. Hand i's
// cards and the target's sampling come from Rng(seed, i), so results do not
// depend on the thread count. Stops after `deals` deals or `max_seconds`.
inline LbrMatch run_lbr_holdem(const BettingTree& tree, const std::vector<float>& pol, const HoldemLbrGame& game,
                               const LbrConfig& cfg, int64_t deals, int threads, uint64_t seed,
                               double max_seconds) {
  Lbr<HoldemLbrGame> lbr(tree, pol, game, cfg);
  struct Acc {
    double s = 0, q = 0, si = 0, qi = 0, seat[2] = {0, 0};
    int64_t n = 0;
    LbrStats st;
  };
  std::vector<Acc> acc(std::max(1, threads));
  std::atomic<int64_t> next{0};
  double t0 = now_sec(), t_end = t0 + max_seconds;
  auto work = [&](int t) {
    Lbr<HoldemLbrGame>::Ctx ctx;
    Acc& A = acc[t];
    while (true) {
      int64_t i = next.fetch_add(1);
      if (i >= deals || now_sec() > t_end) break;
      uint64_t x = seed * 0x9E3779B97F4A7C15ULL + uint64_t(i);
      Rng rng(splitmix64(x));
      Deal d;
      holdem_lbr_deal(rng, d);
      double r = 0, ri = 0;
      for (int me = 0; me < 2; me++) {
        auto res = lbr.play(ctx, d, me, rng);
        r += res.chips;
        ri += res.io;
        A.seat[me] += res.chips;
      }
      r *= 0.5, ri *= 0.5;
      A.s += r, A.q += r * r, A.si += ri, A.qi += ri * ri, A.n++;
    }
    A.st = ctx.stats;
  };
  std::vector<std::thread> pool;
  for (int t = 0; t < int(acc.size()); t++) pool.emplace_back(work, t);
  for (auto& th : pool) th.join();
  LbrMatch m;
  double S = 0, Q = 0, SI = 0, QI = 0, seat[2] = {0, 0};
  for (auto& A : acc) {
    S += A.s, Q += A.q, SI += A.si, QI += A.qi, m.deals += A.n, seat[0] += A.seat[0], seat[1] += A.seat[1];
    m.stats.add(A.st);
  }
  m.seconds = now_sec() - t0;
  if (m.deals == 0) return m;
  double n = double(m.deals);
  m.mean_chips = S / n;
  m.mean_io = SI / n;
  m.ci_chips = 1.96 * std::sqrt(std::max(0.0, Q / n - m.mean_chips * m.mean_chips) / n);
  m.ci_io = 1.96 * std::sqrt(std::max(0.0, QI / n - m.mean_io * m.mean_io) / n);
  m.seat_mean[0] = seat[0] / n;
  m.seat_mean[1] = seat[1] / n;
  return m;
}

}  // namespace bp
