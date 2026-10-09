// ============================================================
// hand_iso.h: optimal lossless hand isomorphism (Waugh 2013).
//
// Thin C++ wrapper over Kevin Waugh's hand-isomorphism library, vendored
// unchanged under third_party/hand-isomorphism (BSD-style license with an
// attribution clause; LICENSE.txt is kept next to the code). Paper: K. Waugh,
// "A Fast and Optimal Hand Isomorphism Algorithm", AAAI-13 Computer Poker
// workshop, https://www.cs.cmu.edu/~waugh/publications/isomorphism13.pdf.
// Code: https://github.com/kdub0/hand-isomorphism (commit dabcee4).
//
// Per-street imperfect-recall indexers: a street's hand is (hole | board) with
// the board unordered, so the index is shared by every hand that differs only
// by a suit relabeling or by the order of cards inside the hole or the board.
// The index is dense in [0, size): no gaps, one index per isomorphism class.
//
//   street 0  {2}      169          (the 169 preflop classes)
//   street 1  {2, 3}   1,286,792    (hole, flop)
//   street 2  {2, 4}   13,960,050   (hole, turn board)
//   street 3  {2, 5}   123,156,254  (hole, river board)
//
// Sizes are asserted in tests/test_abs_v2.cpp against the numbers printed by
// the reference library and independently by brute-force orbit counting.
// Card ids are the trainer's (rank * 4 + suit), which is also the library's
// encoding (deck_make_card), so cards pass through unchanged.
// ============================================================
#pragma once

#include <cstdint>
#include <memory>

namespace bp {

class HandIso {
 public:
  explicit HandIso(int street);  // 0..3
  ~HandIso();
  HandIso(const HandIso&) = delete;
  HandIso& operator=(const HandIso&) = delete;

  int street() const { return street_; }
  int board_cards() const { return nboard_; }
  uint64_t size() const { return size_; }
  // Index of (hole, board); board has board_cards() cards. Thread-safe.
  uint64_t index(const int hole[2], const int* board) const;
  // Canonical representative of an index. Thread-safe.
  void unindex(uint64_t idx, int hole[2], int* board) const;

 private:
  int street_, nboard_;
  uint64_t size_;
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Shared, lazily built indexers (thread-safe initialization).
const HandIso& hand_iso(int street);

}  // namespace bp
