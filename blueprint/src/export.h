// ============================================================
// export.h: compact policy export read by src/core/blueprint/loader.ts.
//
// File layout (little endian):
//   bytes 0..7    magic "GPOBP001"
//   bytes 8..11   u32 header length H
//   bytes 12..    H bytes of UTF-8 JSON header (fields documented in
//                 blueprint/README.md; includes section offsets)
//   nodes         num_nodes records of NODE_RECORD_BYTES (28):
//                   u8 type (0 decision, 1 fold, 2 showdown)
//                   u8 player (actor, or folder for a fold node)
//                   u8 street
//                   u8 nact
//                   u8 act_kind (action that led here; see ActKind)
//                   u8 raises (bets + raises so far on this street)
//                   u16 frac_milli (pot fraction x1000 for bets / raises)
//                   u32 first child index
//                   u32 parent index
//                   u32 strategy offset (byte offset of bucket 0 inside the
//                       strategy section; 0xFFFFFFFF for terminals)
//                   i32 contrib[0], i32 contrib[1] (chips committed)
//   strategy      one byte per (decision node, bucket, action): the average
//                 strategy quantized to integers summing to 255 per infoset
//                 (largest-remainder rounding). An all-zero infoset was never
//                 reached in training; loaders treat it as uniform.
// ============================================================
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "tree.h"

namespace bp {

constexpr int NODE_RECORD_BYTES = 28;

// policy(base, nact, out) -> probabilities; visited(base, nact) -> bool
bool export_policy(const BettingTree& tree, const std::function<void(uint64_t, int, double*)>& policy,
                   const std::function<bool(uint64_t, int)>& visited, const std::string& extra_json,
                   const std::string& path);

// Largest-remainder quantization of probabilities to bytes summing to 255.
void quantize255(const double* p, int n, uint8_t* out);

}  // namespace bp
