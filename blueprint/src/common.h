// ============================================================
// common.h: shared primitives for the blueprint trainer.
//
//   * Card encoding identical to the TypeScript engine
//     (src/types/poker.ts): rank 0..12 (2..A), suit 0..3, id = rank*4 + suit.
//   * A fast, seedable PRNG (xoshiro256++ seeded through splitmix64) with
//     Lemire's unbiased bounded-integer method.
//   * Relaxed atomic load/store helpers. Training threads share the regret
//     and strategy arrays without locks (the "Hogwild" scheme Pluribus used).
//     Plain concurrent reads/writes would be a data race (undefined behavior
//     in C++), so every shared access goes through __atomic builtins with
//     relaxed ordering. On arm64 and x86-64 these compile to ordinary loads
//     and stores, so the cost is zero; lost updates between threads are
//     possible and are tolerated by the algorithm, exactly as in Pluribus.
// ============================================================
#pragma once

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace bp {

// ---- cards ----------------------------------------------------------------
inline int rank_of(int c) { return c >> 2; }
inline int suit_of(int c) { return c & 3; }
inline int make_card(int rank, int suit) { return rank * 4 + suit; }

inline std::string card_str(int c) {
  static const char* R = "23456789TJQKA";
  static const char* S = "hdcs";  // matches src/types/poker.ts suit order
  std::string s;
  s += R[rank_of(c)];
  s += S[suit_of(c)];
  return s;
}

// Parse "Ah", "Td", ... into a card id (-1 on failure).
inline int parse_card(const char* s) {
  static const char* R = "23456789TJQKA";
  static const char* S = "hdcs";
  const char* r = std::strchr(R, s[0]);
  const char* u = std::strchr(S, s[1]);
  if (!r || !u || !s[0] || !s[1]) return -1;
  return make_card(int(r - R), int(u - S));
}

// Colex index of a 2-card combo (any order): 0..1325.
inline int combo_index(int a, int b) {
  if (a < b) std::swap(a, b);
  return a * (a - 1) / 2 + b;
}
constexpr int NUM_COMBOS = 1326;

// Inverse of combo_index, filled once.
struct ComboTable {
  uint8_t hi[NUM_COMBOS], lo[NUM_COMBOS];
  ComboTable() {
    for (int a = 1; a < 52; a++)
      for (int b = 0; b < a; b++) {
        int i = combo_index(a, b);
        hi[i] = uint8_t(a);
        lo[i] = uint8_t(b);
      }
  }
};
const ComboTable& combos();

// Binomial coefficients up to 52 choose 5 (colex board indices).
uint32_t choose(int n, int k);

// ---- RNG ------------------------------------------------------------------
inline uint64_t splitmix64(uint64_t& x) {
  uint64_t z = (x += 0x9E3779B97F4A7C15ULL);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
  return z ^ (z >> 31);
}

struct Rng {
  uint64_t s[4];
  explicit Rng(uint64_t seed = 1) { reseed(seed); }
  void reseed(uint64_t seed) {
    uint64_t x = seed;
    for (auto& v : s) v = splitmix64(x);
  }
  static inline uint64_t rotl(uint64_t x, int k) { return (x << k) | (x >> (64 - k)); }
  inline uint64_t next() {
    uint64_t r = rotl(s[0] + s[3], 23) + s[0];
    uint64_t t = s[1] << 17;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45);
    return r;
  }
  // Uniform integer in [0, n) (Lemire's multiply-shift; bias < 2^-32 for n < 2^32).
  inline uint32_t below(uint32_t n) {
    return uint32_t((uint64_t(uint32_t(next() >> 32)) * n) >> 32);
  }
  // Uniform double in [0, 1).
  inline double uniform() { return double(next() >> 11) * (1.0 / 9007199254740992.0); }
};

// ---- relaxed atomics --------------------------------------------------------
template <class T>
inline T aload(const T* p) {
  T v;
  __atomic_load(p, &v, __ATOMIC_RELAXED);
  return v;
}
template <class T>
inline void astore(T* p, T v) {
  __atomic_store(p, &v, __ATOMIC_RELAXED);
}

// ---- timing -----------------------------------------------------------------
inline double now_sec() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

// FNV-1a, used to fingerprint configs so a checkpoint is never resumed into
// a different tree or abstraction.
inline uint64_t fnv1a(const void* data, size_t n, uint64_t h = 1469598103934665603ULL) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  for (size_t i = 0; i < n; i++) {
    h ^= p[i];
    h *= 1099511628211ULL;
  }
  return h;
}
inline uint64_t fnv1a(const std::string& s, uint64_t h = 1469598103934665603ULL) {
  return fnv1a(s.data(), s.size(), h);
}

[[noreturn]] inline void die(const std::string& msg) {
  std::fprintf(stderr, "fatal: %s\n", msg.c_str());
  std::exit(1);
}

}  // namespace bp
