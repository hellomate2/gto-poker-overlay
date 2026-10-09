// ============================================================
// hand_iso.cpp: C++ wrapper over the vendored Waugh indexer (see hand_iso.h).
// ============================================================
#include "hand_iso.h"

#include <mutex>

#include "common.h"

extern "C" {
#define _Bool bool
#include "../third_party/hand-isomorphism/hand_index.h"
#undef _Bool
}

namespace bp {

struct HandIso::Impl {
  hand_indexer_t ix;
  int round;  // the indexer round that holds the whole street hand
};

HandIso::HandIso(int street) : street_(street), impl_(new Impl) {
  static const int NB[4] = {0, 3, 4, 5};
  if (street < 0 || street > 3) die("HandIso: street must be 0..3");
  nboard_ = NB[street];
  bool ok;
  if (street == 0) {
    uint8_t cpr[1] = {2};
    ok = hand_indexer_init(1, cpr, &impl_->ix);
    impl_->round = 0;
  } else {
    uint8_t cpr[2] = {2, uint8_t(nboard_)};
    ok = hand_indexer_init(2, cpr, &impl_->ix);
    impl_->round = 1;
  }
  if (!ok) die("hand_indexer_init failed");
  size_ = hand_indexer_size(&impl_->ix, uint_fast32_t(impl_->round));
}

HandIso::~HandIso() { hand_indexer_free(&impl_->ix); }

uint64_t HandIso::index(const int hole[2], const int* board) const {
  uint8_t c[7];
  c[0] = uint8_t(hole[0]);
  c[1] = uint8_t(hole[1]);
  for (int i = 0; i < nboard_; i++) c[2 + i] = uint8_t(board[i]);
  return hand_index_last(&impl_->ix, c);
}

void HandIso::unindex(uint64_t idx, int hole[2], int* board) const {
  uint8_t c[7];
  if (!hand_unindex(&impl_->ix, uint_fast32_t(impl_->round), idx, c)) die("hand_unindex failed");
  hole[0] = c[0];
  hole[1] = c[1];
  for (int i = 0; i < nboard_; i++) board[i] = c[2 + i];
}

const HandIso& hand_iso(int street) {
  static std::once_flag once[4];
  static std::unique_ptr<HandIso> inst[4];
  std::call_once(once[street], [street] { inst[street].reset(new HandIso(street)); });
  return *inst[street];
}

}  // namespace bp
