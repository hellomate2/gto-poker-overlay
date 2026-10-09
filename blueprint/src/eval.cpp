// ============================================================
// eval.cpp: table generation for eval.h.
//
// 1. slow_eval5() scores a 5-card rank multiset (plus a "same suit" flag)
//    as category << 20 | tiebreak, where tiebreak lists the ranks ordered by
//    (multiplicity desc, rank desc), four bits each. Straights use their top
//    card (the wheel A-5-4-3-2 tops out at the 5). This is slow and obvious.
// 2. Every quinary vector with 5..7 cards gets the best slow_eval5() over
//    its 5-card sub-multisets, scored as a non-flush hand.
// 3. Every 13-bit rank mask with >= 5 bits gets the best 5-bit sub-mask,
//    scored as a flush (straight flush when the 5 ranks are consecutive).
// 4. All distinct raw scores are sorted and replaced by their dense rank
//    1..N. N must equal 7462 (the number of 5-card equivalence classes);
//    the evaluator self-check and tests/test_main.cpp assert this.
// ============================================================
#include "eval.h"

#include <algorithm>
#include <map>
#include <vector>

#include "common.h"

namespace bp {

namespace {

constexpr int CAT_SHIFT = 20;

uint32_t slow_eval5(const int r[5], bool flush) {
  int cnt[13] = {0};
  for (int i = 0; i < 5; i++) cnt[r[i]]++;
  // ranks ordered by (count desc, rank desc)
  int ord[5], n = 0;
  for (int c = 4; c >= 1; c--)
    for (int k = 12; k >= 0; k--)
      if (cnt[k] == c) ord[n++] = k;
  bool distinct = (n == 5);
  int straight_top = -1;
  if (distinct) {
    if (ord[0] - ord[4] == 4) straight_top = ord[0];
    // wheel: A 5 4 3 2  (ord = 12, 3, 2, 1, 0)
    if (ord[0] == 12 && ord[1] == 3 && ord[4] == 0) straight_top = 3;
  }
  uint32_t tb = 0;
  for (int i = 0; i < n; i++) tb = (tb << 4) | uint32_t(ord[i]);
  int cat;
  if (straight_top >= 0 && flush) return (8u << CAT_SHIFT) | uint32_t(straight_top);
  if (cnt[ord[0]] == 4) cat = 7;
  else if (cnt[ord[0]] == 3 && n == 2) cat = 6;
  else if (flush) cat = 5;
  else if (straight_top >= 0) return (4u << CAT_SHIFT) | uint32_t(straight_top);
  else if (cnt[ord[0]] == 3) cat = 3;
  else if (cnt[ord[0]] == 2 && cnt[ord[1]] == 2) cat = 2;
  else if (cnt[ord[0]] == 2) cat = 1;
  else cat = 0;
  return (uint32_t(cat) << CAT_SHIFT) | tb;
}

// Best non-flush score over 5-subsets of a rank multiset of size n (5..7).
uint32_t best_nonflush(const std::vector<int>& ranks) {
  int n = int(ranks.size());
  uint32_t best = 0;
  int pick[5];
  for (int a = 0; a < n; a++)
    for (int b = a + 1; b < n; b++)
      for (int c = b + 1; c < n; c++)
        for (int d = c + 1; d < n; d++)
          for (int e = d + 1; e < n; e++) {
            pick[0] = ranks[a]; pick[1] = ranks[b]; pick[2] = ranks[c];
            pick[3] = ranks[d]; pick[4] = ranks[e];
            best = std::max(best, slow_eval5(pick, false));
          }
  return best;
}

uint32_t best_flush(uint32_t mask) {
  std::vector<int> rs;
  for (int k = 0; k < 13; k++)
    if (mask >> k & 1) rs.push_back(k);
  uint32_t best = 0;
  int n = int(rs.size()), pick[5];
  for (int a = 0; a < n; a++)
    for (int b = a + 1; b < n; b++)
      for (int c = b + 1; c < n; c++)
        for (int d = c + 1; d < n; d++)
          for (int e = d + 1; e < n; e++) {
            pick[0] = rs[a]; pick[1] = rs[b]; pick[2] = rs[c]; pick[3] = rs[d]; pick[4] = rs[e];
            best = std::max(best, slow_eval5(pick, true));
          }
  return best;
}

void enum_quinary(int rank, int left, uint32_t key, std::vector<int>& ranks,
                  std::vector<std::pair<uint32_t, uint32_t>>& out, const uint32_t* pow5) {
  if (rank == 13) {
    if (ranks.size() >= 5) out.push_back({key, best_nonflush(ranks)});
    return;
  }
  for (int c = 0; c <= 4 && c <= left; c++) {
    for (int i = 0; i < c; i++) ranks.push_back(rank);
    enum_quinary(rank + 1, left - c, key + uint32_t(c) * pow5[rank], ranks, out, pow5);
    for (int i = 0; i < c; i++) ranks.pop_back();
  }
}

EvalTables* build() {
  auto* T = new EvalTables();
  uint32_t pow5[13];
  pow5[0] = 1;
  for (int i = 1; i < 13; i++) pow5[i] = pow5[i - 1] * 5;
  for (int c = 0; c < 52; c++) {
    T->rank_key[c] = pow5[rank_of(c)];
    T->suit_key[c] = 1u << (4 * suit_of(c));
    T->suit_bit[c] = 1ull << (16 * suit_of(c) + rank_of(c));
  }
  // non-flush quinary vectors with 5..7 cards
  std::vector<std::pair<uint32_t, uint32_t>> nf;
  std::vector<int> ranks;
  enum_quinary(0, 7, 0, ranks, nf, pow5);
  // flush masks
  std::vector<uint32_t> fl(1 << 13, 0);
  for (uint32_t m = 0; m < (1u << 13); m++)
    if (__builtin_popcount(m) >= 5) fl[m] = best_flush(m);
  // dense ranking of all distinct raw scores
  std::vector<uint32_t> all;
  for (auto& p : nf) all.push_back(p.second);
  for (uint32_t m = 0; m < (1u << 13); m++)
    if (fl[m]) all.push_back(fl[m]);
  std::sort(all.begin(), all.end());
  all.erase(std::unique(all.begin(), all.end()), all.end());
  T->num_classes = int(all.size());
  auto dense = [&](uint32_t raw) {
    return uint16_t(std::lower_bound(all.begin(), all.end(), raw) - all.begin() + 1);
  };
  for (size_t i = 0; i < all.size(); i++) T->category[i + 1] = uint8_t(all[i] >> CAT_SHIFT);
  T->category[0] = 0;
  for (uint32_t m = 0; m < (1u << 13); m++) T->flush[m] = fl[m] ? dense(fl[m]) : 0;
  std::memset(T->hkey, 0, sizeof(T->hkey));
  for (auto& p : nf) {
    uint32_t i = (p.first * 0x9E3779B1u) >> (32 - EvalTables::HASH_BITS);
    while (T->hkey[i] != 0) i = (i + 1) & (EvalTables::HASH_SIZE - 1);
    T->hkey[i] = p.first;
    T->hval[i] = dense(p.second);
  }
  return T;
}

}  // namespace

const EvalTables& eval_tables() {
  static const EvalTables* T = build();  // thread-safe static init (C++11)
  return *T;
}

const ComboTable& combos() {
  static const ComboTable t;
  return t;
}

uint32_t choose(int n, int k) {
  static uint32_t C[53][8];
  static bool init = [] {
    for (int i = 0; i <= 52; i++)
      for (int j = 0; j < 8; j++)
        C[i][j] = (j == 0) ? 1 : (i == 0 ? 0 : C[i - 1][j - 1] + C[i - 1][j]);
    return true;
  }();
  (void)init;
  if (k < 0 || k > 7 || n < 0) return 0;
  return C[n][k];
}

}  // namespace bp
