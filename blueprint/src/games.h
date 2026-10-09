// ============================================================
// games.h: deal samplers. A Deal is everything chance decides, already
// projected through the card abstraction: the bucket each player sees on
// each street, and the showdown winner. The betting tree (tree.h) supplies
// the rest of the game.
//
//   Kuhn   cards J<Q<K, one each. Bucket = own card. 6 equally likely deals.
//   Leduc  deck {J,J,Q,Q,K,K}; one private card, one public card after
//          round 1. Bucket round 1 = own rank (3); round 2 = own rank * 3 +
//          public rank (9). Pair with the board wins, else high card, equal
//          ranks split. 120 equally likely ordered deals.
//   Hold'em  9 cards from a 52-card deck; buckets from Abstraction.
// ============================================================
#pragma once

#include <vector>

#include "abstraction.h"
#include "eval.h"

namespace bp {

struct Deal {
  uint16_t bucket[2][4];
  uint8_t winner;  // 0, 1, or 2 = tie
  // Hold'em only (for logging / tests): the actual cards.
  int8_t hole[2][2];
  int8_t board[5];
};

struct WeightedDeal {
  Deal d;
  double prob;
};

struct KuhnSampler {
  void sample(Rng& rng, Deal& d) const {
    int a = int(rng.below(3)), b = int(rng.below(2));
    if (b >= a) b++;
    fill(a, b, d);
  }
  static void fill(int a, int b, Deal& d) {
    d.bucket[0][0] = uint16_t(a);
    d.bucket[1][0] = uint16_t(b);
    d.winner = a > b ? 0 : 1;
  }
  static std::vector<WeightedDeal> enumerate() {
    std::vector<WeightedDeal> out;
    for (int a = 0; a < 3; a++)
      for (int b = 0; b < 3; b++)
        if (a != b) {
          WeightedDeal w{};
          fill(a, b, w.d);
          w.prob = 1.0 / 6.0;
          out.push_back(w);
        }
    return out;
  }
};

struct LeducSampler {
  void sample(Rng& rng, Deal& d) const {
    int c[3];
    uint32_t used = 0;
    for (int i = 0; i < 3; i++) {
      int x;
      do x = int(rng.below(6)); while (used >> x & 1);
      used |= 1u << x;
      c[i] = x;
    }
    fill(c[0], c[1], c[2], d);
  }
  // cards 0..5, rank = card / 2
  static void fill(int c0, int c1, int pub, Deal& d) {
    int r0 = c0 / 2, r1 = c1 / 2, rp = pub / 2;
    d.bucket[0][0] = uint16_t(r0);
    d.bucket[1][0] = uint16_t(r1);
    d.bucket[0][1] = uint16_t(r0 * 3 + rp);
    d.bucket[1][1] = uint16_t(r1 * 3 + rp);
    if (r0 == rp) d.winner = 0;
    else if (r1 == rp) d.winner = 1;
    else if (r0 == r1) d.winner = 2;
    else d.winner = r0 > r1 ? 0 : 1;
  }
  static std::vector<WeightedDeal> enumerate() {
    std::vector<WeightedDeal> out;
    for (int a = 0; a < 6; a++)
      for (int b = 0; b < 6; b++)
        for (int p = 0; p < 6; p++)
          if (a != b && a != p && b != p) {
            WeightedDeal w{};
            fill(a, b, p, w.d);
            w.prob = 1.0 / 120.0;
            out.push_back(w);
          }
    return out;
  }
};

struct HoldemSampler {
  const Abstraction* abs = nullptr;
  void sample(Rng& rng, Deal& d) const {
    uint64_t used = 0;
    int c[9];
    for (int i = 0; i < 9; i++) {
      int x;
      do x = int(rng.below(52)); while (used >> x & 1);
      used |= 1ull << x;
      c[i] = x;
    }
    fill(c, d);
  }
  // c = [h0a, h0b, h1a, h1b, board0..4]
  void fill(const int* c, Deal& d) const {
    const int* h0 = c;
    const int* h1 = c + 2;
    const int* board = c + 4;
    for (int i = 0; i < 2; i++) {
      d.hole[0][i] = int8_t(h0[i]);
      d.hole[1][i] = int8_t(h1[i]);
    }
    for (int i = 0; i < 5; i++) d.board[i] = int8_t(board[i]);
    d.bucket[0][0] = uint16_t(preflop_class(h0[0], h0[1]));
    d.bucket[1][0] = uint16_t(preflop_class(h1[0], h1[1]));
    d.bucket[0][1] = uint16_t(abs->flop(h0, board));
    d.bucket[1][1] = uint16_t(abs->flop(h1, board));
    d.bucket[0][2] = uint16_t(abs->turn(h0, board));
    d.bucket[1][2] = uint16_t(abs->turn(h1, board));
    if (abs->has_river_table()) {
      d.bucket[0][3] = uint16_t(abs->river(h0, board));
      d.bucket[1][3] = uint16_t(abs->river(h1, board));
    } else {
      float e[2];
      river_ehs_pair(board, h0, h1, e);
      d.bucket[0][3] = uint16_t(abs->river_from_ehs(e[0]));
      d.bucket[1][3] = uint16_t(abs->river_from_ehs(e[1]));
    }
    int s0[7] = {h0[0], h0[1], board[0], board[1], board[2], board[3], board[4]};
    int s1[7] = {h1[0], h1[1], board[0], board[1], board[2], board[3], board[4]};
    int v0 = eval_n(s0, 7), v1 = eval_n(s1, 7);
    d.winner = v0 > v1 ? 0 : v1 > v0 ? 1 : 2;
  }
};

}  // namespace bp
