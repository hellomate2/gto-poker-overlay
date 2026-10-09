// ============================================================
// eval.h: fast 5..7 card hand evaluator.
//
// Same idea as the perfect-hash evaluator in src/core/equity/eval-tables.ts
// (phevaluator, Henry Lee, Apache-2.0): split every hand into
//   (a) a flush lookup keyed by the 13-bit rank mask of the flush suit, and
//   (b) a non-flush lookup keyed by the per-rank count vector (the
//       "quinary" vector, each rank appears 0..4 times).
// We differ from the TS port in how (b) is keyed, to make evaluation
// incremental (the hot loops add two hole cards to a fixed board):
//
//   rank key  = sum over cards of 5^rank. Because every per-rank count is
//               <= 4, this is the base-5 number whose digits ARE the quinary
//               vector, so it is unique per vector. It is additive, so a
//               board's key plus two hole-card keys is the 7-card key.
//               Max value 4*5^12 + 3*5^11 < 2^32, so it fits a uint32.
//   suit key  = sum over cards of 1 << (4*suit): four 4-bit counters.
//               (skey + 0x3333) & 0x8888 is nonzero iff some counter >= 5,
//               i.e. iff the hand contains a flush (counter max is 7, and
//               7 + 3 = 10 never carries out of its nibble).
//   suit mask = OR over cards of 1 << (16*suit + rank): the four 13-bit
//               per-suit rank masks packed in one uint64.
//
// The non-flush table is an open-addressed hash (2^18 slots, ~28% load)
// over the 73,775 quinary vectors with 5..7 cards. Tables are generated at
// startup from a slow, obviously-correct 5-card evaluator (a few ms).
//
// Output convention: dense strength 1..7462, HIGHER == better
// (7462 == royal flush, 1 == 7-5-4-3-2 offsuit). hand_category() maps a
// strength to 0 (high card) .. 8 (straight flush).
// ============================================================
#pragma once

#include <cstdint>

namespace bp {

struct EvalTables {
  static constexpr int HASH_BITS = 18;
  static constexpr uint32_t HASH_SIZE = 1u << HASH_BITS;
  uint32_t rank_key[52];
  uint32_t suit_key[52];
  uint64_t suit_bit[52];
  uint16_t flush[1 << 13];  // rank mask (popcount >= 5) -> strength
  uint32_t hkey[HASH_SIZE];  // 0 == empty (a valid key is never 0)
  uint16_t hval[HASH_SIZE];
  uint8_t category[7463];
  int num_classes = 0;
};

const EvalTables& eval_tables();

// An incrementally built hand (board + hole cards).
struct HandAcc {
  uint32_t rkey = 0, skey = 0;
  uint64_t smask = 0;
  inline void add(int c, const EvalTables& T) {
    rkey += T.rank_key[c];
    skey += T.suit_key[c];
    smask |= T.suit_bit[c];
  }
};

inline uint16_t eval_acc(const HandAcc& h, const EvalTables& T) {
  uint32_t f = (h.skey + 0x3333u) & 0x8888u;
  if (f) {
    int s = __builtin_ctz(f) >> 2;
    return T.flush[(h.smask >> (16 * s)) & 0x1FFF];
  }
  uint32_t i = (h.rkey * 0x9E3779B1u) >> (32 - EvalTables::HASH_BITS);
  while (T.hkey[i] != h.rkey) i = (i + 1) & (EvalTables::HASH_SIZE - 1);
  return T.hval[i];
}

// Evaluate n (5..7) cards.
inline uint16_t eval_n(const int* cards, int n) {
  const EvalTables& T = eval_tables();
  HandAcc h;
  for (int i = 0; i < n; i++) h.add(cards[i], T);
  return eval_acc(h, T);
}

inline int hand_category(uint16_t strength) { return eval_tables().category[strength]; }

}  // namespace bp
