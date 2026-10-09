// ============================================================
// serve.h: `bp serve`, the blueprint as a line-delimited JSON service.
//
// The TS BlueprintAgent (src/core/blueprint/agent.ts) maps a real game state
// to an abstract history and asks this process for the average-policy action
// probabilities at (history, hole, board). Everything card-related happens
// here, with the trainer's own tables: the bucket comes from the same
// Abstraction object the trainer loads (preflop class, flop/turn k-means
// tables, river lookup table), and the node comes from BettingTree::find on
// the same tree, so there is no train/serve mismatch to drift.
//
// Protocol: one JSON object per line on stdin, one JSON object per line on
// stdout, answered in order. Requests are flat objects with string or
// number values; an optional numeric "id" is echoed back.
//
//   {"cmd":"info"}
//     -> tree description, abstraction id, iterations, stack, blinds,
//        min_bet, buckets per street, node count
//   {"cmd":"node","history":"r0.5 c k"}
//     -> node index, type (decision/fold/showdown), player, street,
//        contrib [p0, p1] in tree chips, raises, and for a decision node the
//        actions [{"tok","contrib":[p0,p1]}] (contrib after each action)
//   {"cmd":"policy","history":"r0.5 c","hole":"AhKd","board":"2c3d4h"}
//     -> the node fields above plus "bucket" and "probs" (average strategy,
//        same order as "actions"). The board must have exactly the cards of
//        the node's street (0, 3, 4 or 5).
//   {"cmd":"search","history":"r1 c k k k k k b0.8","hole":"QhJh",
//    "board":"Qs7h2d9c3s","budget-ms":1500,"min-iters":100}
//     -> real-time search at the hero's decision (src/search.h,
//        serve_search): the same request parsing and solver run as
//        `bp search` with the same keys. The history may end with off-tree
//        sizes in the current turn or river round ("b0.8"). Reply: "labels"
//        (the hero node's actions), "probs" (searched average strategy),
//        "bp_probs" (the blueprint's, empty off-tree), "iters", "complete"
//        (iters >= min-iters), "setup_ms", "solve_ms", "ms".
//
// Errors come back as {"ok":false,"error":"..."} and the loop keeps going.
// ============================================================
#pragma once

#include <cstdio>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "abstraction.h"
#include "tree.h"

namespace bp {

// Minimal flat-object JSON reader: {"key": "string" | number | true | false
// | null, ...}. Returns false on malformed input. Values are kept as text
// (strings unescaped), numbers as their literal.
bool parse_flat_json(const std::string& line, std::map<std::string, std::string>& out, std::string* err = nullptr);

// Card bucket of `hole` at `street`, computed exactly as HoldemSampler::fill
// computes it for training (preflop class, flop/turn tables, river table or
// river EHS when the table is not built). `board` holds at least the street's
// cards (3, 4 or 5).
int serve_bucket(const Abstraction& abs, int street, const int hole[2], const int* board);

struct ServeCtx {
  const BettingTree* tree = nullptr;
  const Abstraction* abs = nullptr;  // may be null: only "info" and "node" then
  const std::vector<float>* pol = nullptr;  // average strategy per slot
  long long iterations = 0;
  std::string abs_id;
  // "search" handler (set by cmd_serve when a checkpoint is loaded): returns
  // the reply fields after "ok"/"id", each starting with ','. May throw
  // (DieError); serve_handle turns that into an error reply.
  std::function<std::string(const std::map<std::string, std::string>&)> search;
};

// Answer one request line (no trailing newline in the result).
std::string serve_handle(const ServeCtx& ctx, const std::string& line);

// Read requests from `in` until EOF, answer each on `out`, flush per line.
int serve_loop(const ServeCtx& ctx, FILE* in, FILE* out);

// Parity fixture: n infosets drawn from the trainer's own sampling path
// (HoldemSampler deal, then a uniform random walk through the tree to a
// decision node; streets stratified i % 4). Each output line holds the
// request a client would send and the expected answer taken straight from
// the trainer (Deal::bucket and `avg`, NOT through serve_bucket / the policy
// vector), so a client can check bucket, node and probabilities end to end.
using AvgFn = std::function<void(uint64_t base, int nact, double* out)>;
int serve_parity_dump(const BettingTree& tree, const Abstraction& abs, const AvgFn& avg, int n, uint64_t seed,
                      FILE* out);

}  // namespace bp
