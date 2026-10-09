// ============================================================
// tree.cpp: betting-tree construction for limit and no-limit rules.
//
// No-limit sizing (all amounts are total chips committed by the actor):
//   not facing a bet:  bet_to   = mine + max(min_bet, frac * pot)
//   facing a bet:      raise_to = theirs + max(last_increment, frac * (pot + to_call))
// i.e. "frac pot" means a fraction of the pot AFTER calling, the usual
// definition of a pot-sized raise. A size that would reach the stack is
// dropped in favor of the explicit all-in action; duplicate sizes are merged.
//
// Street flow:
//   * a check closes the street if it is not the first action on the street;
//   * a call closes the street if it is not the first action on the street
//     (the only first-action call is the small blind completing preflop,
//     after which the big blind keeps the option);
//   * a call with either player all-in, or closing the last street, goes to
//     SHOWDOWN (the deal already fixes the whole board).
// ============================================================
#include "tree.h"

#include <algorithm>
#include <cmath>
#include <sstream>

namespace bp {

std::vector<float> parse_fracs(const std::string& s) {
  std::vector<float> out;
  std::stringstream ss(s);
  std::string tok;
  while (std::getline(ss, tok, ','))
    if (!tok.empty()) out.push_back(std::stof(tok));
  return out;
}

std::string TreeConfig::describe() const {
  std::ostringstream o;
  o << "name=" << name << ";streets=" << nstreets << ";stack=" << stack << ";blind=" << blind[0] << ","
    << blind[1] << ";min_bet=" << min_bet;
  for (int s = 0; s < nstreets; s++) {
    const StreetRules& r = street[s];
    o << ";s" << s << ":first=" << r.first_player << ",max_raises=" << r.max_raises;
    if (r.limit) {
      o << ",limit=" << r.limit_bet;
    } else {
      o << ",bet=";
      for (size_t i = 0; i < r.bet_fracs.size(); i++) o << (i ? "/" : "") << r.bet_fracs[i];
      o << ",raise=";
      for (size_t i = 0; i < r.raise_fracs.size(); i++) o << (i ? "/" : "") << r.raise_fracs[i];
      o << ",allin=" << (r.allin ? 1 : 0);
    }
  }
  return o.str();
}

namespace {

struct BState {
  int32_t c[2];
  int street, player, raises, actions;
  int32_t last_inc;
};

struct Act {
  uint8_t kind;
  int32_t to;  // actor's total commitment after the action
  uint16_t frac_milli;
};

void legal_actions(const TreeConfig& cfg, const BState& s, std::vector<Act>& out) {
  out.clear();
  const StreetRules& r = cfg.street[s.street];
  int p = s.player, o = 1 - p;
  int32_t mine = s.c[p], theirs = s.c[o], maxc = std::max(mine, theirs);
  int32_t to_call = maxc - mine;
  int32_t pot = s.c[0] + s.c[1];
  if (to_call > 0) {
    out.push_back({ACT_FOLD, mine, 0});
    out.push_back({ACT_CALL, std::min(maxc, cfg.stack), 0});
  } else {
    out.push_back({ACT_CHECK, mine, 0});
  }
  bool can_raise = s.raises < r.max_raises && theirs < cfg.stack && mine + to_call < cfg.stack;
  if (!can_raise) return;
  uint8_t kind = to_call > 0 ? ACT_RAISE : ACT_BET;
  if (r.limit) {
    out.push_back({kind, std::min(cfg.stack, maxc + r.limit_bet), 0});
    return;
  }
  const std::vector<float>& fr = to_call > 0 ? r.raise_fracs : r.bet_fracs;
  std::vector<int32_t> seen;
  for (float f : fr) {
    int32_t to;
    if (to_call == 0) {
      to = mine + std::max(cfg.min_bet, int32_t(std::lround(f * pot)));
    } else {
      int32_t inc = std::max(s.last_inc, int32_t(std::lround(f * (pot + to_call))));
      to = maxc + inc;
    }
    if (to >= cfg.stack) {
      if (r.allin) continue;  // covered by the explicit all-in
      to = cfg.stack;
    }
    if (std::find(seen.begin(), seen.end(), to) != seen.end()) continue;
    seen.push_back(to);
    out.push_back({kind, to, uint16_t(std::lround(f * 1000))});
  }
  if (r.allin && std::find(seen.begin(), seen.end(), cfg.stack) == seen.end())
    out.push_back({ACT_ALLIN, cfg.stack, 0});
}

struct Builder {
  const TreeConfig& cfg;
  std::vector<Node>& nodes;
  std::vector<Act> scratch;

  void expand(uint32_t idx, const BState& s) {
    std::vector<Act> acts;
    legal_actions(cfg, s, acts);
    uint32_t first = uint32_t(nodes.size());
    nodes.resize(first + acts.size());
    nodes[idx].child = first;
    nodes[idx].nact = uint8_t(acts.size());
    nodes[idx].player = uint8_t(s.player);
    nodes[idx].street = uint8_t(s.street);
    nodes[idx].type = DECISION;
    for (size_t a = 0; a < acts.size(); a++) {
      const Act& A = acts[a];
      BState t = s;
      int p = s.player, o = 1 - p;
      uint32_t ci = first + uint32_t(a);
      Node n;
      n.parent = idx;
      n.act_kind = A.kind;
      n.frac_milli = A.frac_milli;
      n.street = uint8_t(s.street);
      bool to_next_street = false, showdown = false;
      if (A.kind == ACT_FOLD) {
        n.type = FOLD;
        n.player = uint8_t(p);
      } else if (A.kind == ACT_CHECK) {
        if (s.actions >= 1) to_next_street = true;
      } else if (A.kind == ACT_CALL) {
        t.c[p] = A.to;
        if (t.c[p] >= cfg.stack || t.c[o] >= cfg.stack) showdown = true;
        else if (s.actions >= 1) to_next_street = true;
      } else {  // bet / raise / all-in
        int32_t maxc = std::max(s.c[0], s.c[1]);
        t.last_inc = std::max(s.last_inc, A.to - maxc);
        t.c[p] = A.to;
        t.raises = s.raises + 1;
      }
      t.actions = s.actions + 1;
      t.player = o;
      if (to_next_street) {
        if (s.street + 1 >= cfg.nstreets) {
          showdown = true;
        } else {
          t.street = s.street + 1;
          t.raises = 0;
          t.actions = 0;
          t.last_inc = cfg.min_bet;
          t.player = cfg.street[t.street].first_player;
        }
      }
      if (showdown) n.type = SHOWDOWN;
      n.contrib[0] = t.c[0];
      n.contrib[1] = t.c[1];
      n.raises = uint8_t(t.raises);
      if (n.type == DECISION) n.street = uint8_t(t.street);
      nodes[ci] = n;
      if (n.type == DECISION) expand(ci, t);
    }
  }
};

}  // namespace

void BettingTree::build(const TreeConfig& c, const int* b) {
  cfg = c;
  for (int s = 0; s < 4; s++) buckets[s] = s < c.nstreets ? b[s] : 1;
  nodes.clear();
  nodes.emplace_back();
  BState s;
  s.c[0] = c.blind[0];
  s.c[1] = c.blind[1];
  s.street = 0;
  s.player = c.street[0].first_player;
  s.raises = 0;
  s.actions = 0;
  s.last_inc = c.min_bet;
  nodes[0].contrib[0] = s.c[0];
  nodes[0].contrib[1] = s.c[1];
  Builder bld{cfg, nodes, {}};
  bld.expand(0, s);
  num_slots = 0;
  for (auto& n : nodes)
    if (n.type == DECISION) {
      n.slot = num_slots;
      num_slots += uint64_t(buckets[n.street]) * n.nact;
    }
  if (nodes.size() >= 0xFFFFFFFFull) die("tree too large");
}

std::string BettingTree::token(uint32_t i) const {
  const Node& n = nodes[i];
  char buf[32];
  switch (n.act_kind) {
    case ACT_FOLD: return "f";
    case ACT_CHECK: return "k";
    case ACT_CALL: return "c";
    case ACT_ALLIN: return "a";
    case ACT_BET:
    case ACT_RAISE:
      if (cfg.street[nodes[n.parent].street].limit) return n.act_kind == ACT_BET ? "b" : "r";
      std::snprintf(buf, sizeof buf, "%c%g", n.act_kind == ACT_BET ? 'b' : 'r', n.frac_milli / 1000.0);
      return buf;
    default: return "";
  }
}

std::string BettingTree::history(uint32_t i) const {
  std::vector<std::string> t;
  while (i != 0) {
    t.push_back(token(i));
    i = nodes[i].parent;
  }
  std::string s;
  for (size_t k = t.size(); k-- > 0;) s += (s.empty() ? "" : " ") + t[k];
  return s;
}

int64_t BettingTree::find(const std::vector<std::string>& toks) const {
  uint32_t cur = 0;
  for (const auto& tk : toks) {
    const Node& n = nodes[cur];
    if (n.type != DECISION) return -1;
    bool ok = false;
    for (int a = 0; a < n.nact; a++)
      if (token(n.child + a) == tk) {
        cur = n.child + a;
        ok = true;
        break;
      }
    if (!ok) return -1;
  }
  return cur;
}

void BettingTree::print_stats(FILE* out) const {
  size_t dec[4] = {0}, term = 0;
  uint64_t slots[4] = {0};
  for (auto& n : nodes) {
    if (n.type == DECISION) {
      dec[n.street]++;
      slots[n.street] += uint64_t(buckets[n.street]) * n.nact;
    } else {
      term++;
    }
  }
  std::fprintf(out, "tree %s: %zu nodes (%zu terminal)\n", cfg.name.c_str(), nodes.size(), term);
  for (int s = 0; s < cfg.nstreets; s++)
    std::fprintf(out, "  street %d: %zu decision nodes x %d buckets -> %llu regret slots\n", s, dec[s],
                 buckets[s], (unsigned long long)slots[s]);
  std::fprintf(out, "  total slots %llu  (%.1f MB at 12 bytes/slot: int32 regret + double avg)\n",
               (unsigned long long)num_slots, num_slots * 12.0 / 1e6);
}

// ---- named configs ------------------------------------------------------------

TreeConfig kuhn_config() {
  TreeConfig c;
  c.name = "kuhn";
  c.nstreets = 1;
  c.stack = 1000;
  c.blind[0] = c.blind[1] = 1;  // antes
  c.min_bet = 1;
  c.street[0].limit = true;
  c.street[0].limit_bet = 1;
  c.street[0].max_raises = 1;
  c.street[0].first_player = 0;
  return c;
}

TreeConfig leduc_config() {
  TreeConfig c;
  c.name = "leduc";
  c.nstreets = 2;
  c.stack = 1000;
  c.blind[0] = c.blind[1] = 1;
  c.min_bet = 2;
  for (int s = 0; s < 2; s++) {
    c.street[s].limit = true;
    c.street[s].limit_bet = s == 0 ? 2 : 4;
    c.street[s].max_raises = 2;
    c.street[s].first_player = 0;
  }
  return c;
}

// Hold'em presets. Chips: SB 50, BB 100, 100 BB stacks (10,000), the same
// units Pluribus used, so its pruning threshold and regret floor transfer
// unchanged. Player 0 is the small blind / button: first to act preflop,
// last to act postflop.
TreeConfig holdem_config(const std::string& preset) {
  TreeConfig c;
  c.name = "holdem-" + preset;
  c.nstreets = 4;
  c.stack = 10000;
  c.blind[0] = 50;
  c.blind[1] = 100;
  c.min_bet = 100;
  for (int s = 0; s < 4; s++) c.street[s].first_player = s == 0 ? 0 : 1;
  if (preset == "tiny") {
    // laptop smoke tests: one size per street plus all-in
    c.street[0].bet_fracs = c.street[0].raise_fracs = {1.0f};
    c.street[0].max_raises = 3;
    for (int s = 1; s < 4; s++) {
      c.street[s].bet_fracs = {0.75f};
      c.street[s].raise_fracs = {1.0f};
      c.street[s].max_raises = 2;
    }
  } else if (preset == "small") {
    // default laptop run: 2-3 sizes, few raises
    c.street[0].bet_fracs = c.street[0].raise_fracs = {0.5f, 1.0f};
    c.street[0].max_raises = 3;
    for (int s = 1; s < 4; s++) {
      c.street[s].bet_fracs = {0.5f, 1.0f};
      c.street[s].raise_fracs = {1.0f};
      c.street[s].max_raises = 2;
    }
  } else if (preset == "medium") {
    // a first step toward a rented-compute run
    c.street[0].bet_fracs = c.street[0].raise_fracs = {0.5f, 1.0f, 2.0f};
    c.street[0].max_raises = 4;
    for (int s = 1; s < 4; s++) {
      c.street[s].bet_fracs = {0.33f, 0.66f, 1.0f, 2.0f};
      c.street[s].raise_fracs = {0.66f, 1.0f, 2.0f};
      c.street[s].max_raises = 3;
    }
  } else {
    die("unknown holdem preset: " + preset);
  }
  return c;
}

}  // namespace bp
